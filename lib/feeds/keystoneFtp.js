// Client FTPS da Keystone (ftp.ekeystone.com) para o fetch dos feeds
// Inventory.csv / SpecialOrder.csv. Loop de download com resume por byte
// portado de prisma/seeds/api-calls/keystone-ftp.js:53-98 — mas com
// credenciais SEMPRE por env (KEYSTONE_FTP_USER/PASS ja existem como secret
// no deploy; o script legado tinha as credenciais hardcoded).
//
// basic-ftp entra por parametro para os testes rodarem sem rede.

const fs = require('fs');
const basicFtp = require('basic-ftp');

const DEFAULT_HOST = 'ftp.ekeystone.com';
const DEFAULT_PORT = 990; // FTPS implicito
const SOCKET_TIMEOUT_MS = 180000;
// O servidor da Keystone derruba transfers longos com 426 no meio do arquivo
// de ~460MB; o resume por byte recupera, mas precisa de folga de tentativas.
const DEFAULT_MAX_ATTEMPTS = 10;

function createKeystoneFtpClient({ ftp = basicFtp, env = process.env } = {}) {
	const host = env.KEYSTONE_FTP_HOST || DEFAULT_HOST;
	const port = Number(env.KEYSTONE_FTP_PORT || DEFAULT_PORT);
	const user = env.KEYSTONE_FTP_USER || '';
	const password = env.KEYSTONE_FTP_PASS || '';
	const maxAttempts = Math.max(1, Number(env.KEYSTONE_FTP_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS));
	// Comportamento herdado do script legado; endurecer quando o certificado
	// do host for validado (KEYSTONE_FTP_TLS_REJECT_UNAUTHORIZED=true).
	const rejectUnauthorized = env.KEYSTONE_FTP_TLS_REJECT_UNAUTHORIZED === 'true';

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
					secureOptions: { rejectUnauthorized },
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
