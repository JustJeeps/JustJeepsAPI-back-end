// Client FTPS da Keystone (ftp.ekeystone.com) para o fetch dos feeds
// Inventory.csv / SpecialOrder.csv. Loop de download com resume por byte
// portado de prisma/seeds/api-calls/keystone-ftp.js:53-98 — mas com
// credenciais SEMPRE por env (KEYSTONE_FTP_USER/PASS ja existem como secret
// no deploy; o script legado tinha as credenciais hardcoded).
//
// basic-ftp entra por parametro para os testes rodarem sem rede.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const basicFtp = require('basic-ftp');

const DEFAULT_HOST = 'ftp.ekeystone.com';
const DEFAULT_PORT = 990; // FTPS implicito
// O servidor da Keystone manda SO o certificado folha, sem o intermediario
// (GeoTrust TLS RSA CA G1, da DigiCert) — o Node nao monta a cadeia sozinho e
// falha com "unable to verify the first certificate". A correcao certa nao e
// desligar a verificacao: e fornecer o intermediario que falta, mantendo
// assinatura e hostname validados.
//
// O arquivo NAO fica no repositorio. Ordem de resolucao:
//   1. KEYSTONE_FTP_CA_PEM     conteudo do PEM (ou base64) direto na env
//   2. KEYSTONE_FTP_CA_FILE    caminho absoluto fora do projeto
//   3. objeto privado no Space (KEYSTONE_FTP_CA_OBJECT_KEY, default abaixo),
//      baixado uma vez e guardado no cache local de feeds
const DEFAULT_CA_OBJECT_KEY = 'certs/keystone-ftp-ca.pem';
const SOCKET_TIMEOUT_MS = 180000;
// O servidor da Keystone derruba transfers longos com 426 no meio do arquivo
// de ~460MB; o resume por byte recupera, mas precisa de folga de tentativas.
const DEFAULT_MAX_ATTEMPTS = 10;

// Busca o PEM na env ou no bucket privado. Nunca no repositorio.
async function loadExtraCa({ env, store, cacheDir }) {
	const inline = env.KEYSTONE_FTP_CA_PEM;
	if (inline) {
		return inline.includes('BEGIN CERTIFICATE')
			? inline
			: Buffer.from(inline, 'base64').toString('utf8');
	}

	if (env.KEYSTONE_FTP_CA_FILE && fs.existsSync(env.KEYSTONE_FTP_CA_FILE)) {
		return fs.readFileSync(env.KEYSTONE_FTP_CA_FILE, 'utf8');
	}

	const objectKey = env.KEYSTONE_FTP_CA_OBJECT_KEY || DEFAULT_CA_OBJECT_KEY;
	const cachePath = path.join(cacheDir, 'certs', path.basename(objectKey));
	if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');

	if (!store || !store.isConfigured || !store.isConfigured()) return null;
	try {
		const { body } = await store.getObjectStream(objectKey);
		const chunks = [];
		for await (const chunk of body) chunks.push(chunk);
		const pem = Buffer.concat(chunks).toString('utf8');
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, pem);
		return pem;
	} catch (error) {
		console.warn(`⚠️ Nao foi possivel ler ${objectKey} do bucket: ${error.message}`);
		return null;
	}
}

function createKeystoneFtpClient({
	ftp = basicFtp,
	env = process.env,
	store = null,
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
} = {}) {
	const host = env.KEYSTONE_FTP_HOST || DEFAULT_HOST;
	const port = Number(env.KEYSTONE_FTP_PORT || DEFAULT_PORT);
	const user = env.KEYSTONE_FTP_USER || '';
	const password = env.KEYSTONE_FTP_PASS || '';
	const maxAttempts = Math.max(1, Number(env.KEYSTONE_FTP_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS));
	// Certificado VALIDADO por padrao. Sem isso, um atacante no caminho de rede
	// termina a sessao FTPS com qualquer certificado, captura as credenciais e
	// devolve um Inventory/SpecialOrder forjado — que passaria pelos gates de
	// tamanho/header e entraria no catalogo como lote corrente (o consumidor
	// roda com staleStrategy "delete"). Opt-out explicito so para diagnostico.
	const rejectUnauthorized = env.KEYSTONE_FTP_TLS_REJECT_UNAUTHORIZED !== 'false';

	// Raizes do sistema + o intermediario que o servidor omite. Passar so o
	// intermediario em `ca` SUBSTITUIRIA a lista de raizes do Node e quebraria
	// a validacao — por isso os dois juntos. Resolvido uma vez por processo.
	let cachedBundle = null;
	const caBundle = async () => {
		if (cachedBundle !== null) return cachedBundle;
		const extra = await loadExtraCa({ env, store, cacheDir });
		cachedBundle = extra ? [...tls.rootCertificates, extra] : undefined;
		if (!extra) {
			console.warn('⚠️ CA intermediaria da Keystone nao encontrada (env ou bucket) — a validacao TLS vai falhar');
		}
		return cachedBundle;
	};

	const assertConfigured = () => {
		if (!user || !password) {
			throw new Error('KEYSTONE_FTP_USER/KEYSTONE_FTP_PASS ausentes no ambiente');
		}
	};

	async function downloadFile(remoteFile, localPath) {
		assertConfigured();
		let lastError = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const client = new ftp.Client();
			client.ftp.socketTimeout = SOCKET_TIMEOUT_MS;
			client.prepareTransfer = ftp.enterPassiveModeIPv4;

			try {
				// Resume do byte onde o download anterior parou (SpecialOrder ~460MB).
				let startAt = 0;
				if (fs.existsSync(localPath)) {
					startAt = fs.statSync(localPath).size;
					if (startAt > 0) console.log(`⏩ Resuming ${remoteFile} from byte ${startAt}`);
				}

				await client.access({
					host,
					port,
					user,
					password,
					secure: 'implicit',
					secureOptions: { rejectUnauthorized, ca: await caBundle(), servername: host },
					timeout: SOCKET_TIMEOUT_MS,
				});

				const writeStream = fs.createWriteStream(localPath, { flags: startAt > 0 ? 'a' : 'w' });
				console.log(`📥 Downloading ${remoteFile} (attempt ${attempt}/${maxAttempts})...`);
				await client.download(writeStream, remoteFile, startAt);
				client.close();
				return;
			} catch (error) {
				lastError = error;
				console.warn(`⚠️ Download de ${remoteFile} falhou (tentativa ${attempt}/${maxAttempts}): ${error.message}`);
				client.close();
			}
		}

		throw new Error(`Nao foi possivel baixar ${remoteFile} apos ${maxAttempts} tentativas: ${lastError?.message}`);
	}

	return { downloadFile };
}

module.exports = { createKeystoneFtpClient };
