// Fetch dos feeds da Keystone (FTP) para o landing zone no Spaces. Aquisicao
// PURA: baixa, valida, sobe e cataloga — nao toca em Product/VendorProduct
// (isso e papel do seed-keystone-ftp2 na proxima rodada do seed-all).
//
// Garantias:
//  - gates de sanidade (tamanho minimo + header VCPN) ANTES de catalogar;
//  - os DOIS arquivos sobem antes de registrar o lote (upload parcial nao
//    cataloga nada — o lote anterior continua corrente);
//  - hashes iguais ao lote corrente => skip sem upload (economiza PUT de
//    ~460MB) registrado como skipped-unchanged;
//  - cache local aquecido apos catalogar (o seed-all seguinte nao redownloada).
//
// Dependencias injetadas para testes sem rede/DB.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FEED_NAME = 'keystone-ftp';
const RUN_FEED = 'keystone-ftp-fetch'; // heartbeat separado das rodadas de consumo

const sha256File = (filePath) =>
	new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(filePath)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});

function firstLine(filePath) {
	const buffer = Buffer.alloc(4096);
	const fd = fs.openSync(filePath, 'r');
	try {
		const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString('utf8', 0, bytes).split('\n')[0] || '';
	} finally {
		fs.closeSync(fd);
	}
}

async function runKeystoneFetch({
	ftpClient,
	store,
	prisma,
	catalog = require('../../lib/feeds/catalog'),
	feedsConfig = require('../../config/feeds'),
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	env = process.env,
	now = () => new Date(),
}) {
	const feed = feedsConfig.getFeedByName(FEED_NAME);
	const minBytes = {
		'Inventory.csv': Number(env.KEYSTONE_FTP_MIN_INVENTORY_BYTES || 5 * 1024 * 1024),
		'SpecialOrder.csv': Number(env.KEYSTONE_FTP_MIN_SPECIALORDER_BYTES || 200 * 1024 * 1024),
	};
	// O consumidor (seed-keystone-ftp2) roda com staleStrategy "delete": um
	// download truncado que passe pelo floor fixo apagaria as linhas ausentes.
	// Por isso o gate real e comparativo com o lote corrente.
	const minRatioVsCurrent = Number(env.KEYSTONE_FTP_MIN_SIZE_RATIO || 0.9);

	const run = await prisma.ingestRun.create({
		data: { feed: RUN_FEED, sourceKind: 'ftp', sourceRef: feed.files.join('+') },
	});
	const finishRun = (data) => prisma.ingestRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ...data } });

	try {
		// Scratch novo por execucao; incoming/ inteiro e descartavel.
		const scratchDir = path.join(cacheDir, 'incoming', FEED_NAME, String(Date.now()));
		fs.rmSync(path.join(cacheDir, 'incoming', FEED_NAME), { recursive: true, force: true });
		fs.mkdirSync(scratchDir, { recursive: true });

		const current = await catalog.getCurrentBatch(prisma, FEED_NAME, feed.files);
		const currentSizes = new Map((current?.artifacts || []).map((artifact) => [artifact.fileName, Number(artifact.sizeBytes)]));

		const files = [];
		for (const fileName of feed.files) {
			const localPath = path.join(scratchDir, fileName);
			await ftpClient.downloadFile(fileName, localPath);

			const sizeBytes = fs.statSync(localPath).size;
			if (sizeBytes < minBytes[fileName]) {
				throw new Error(`${fileName} tem ${sizeBytes} bytes (< minimo ${minBytes[fileName]}) — download truncado?`);
			}
			const previousSize = currentSizes.get(fileName);
			if (previousSize && sizeBytes < previousSize * minRatioVsCurrent) {
				throw new Error(
					`${fileName} encolheu para ${sizeBytes} bytes (lote atual tem ${previousSize}, minimo ${Math.round(minRatioVsCurrent * 100)}%) — download truncado?`
				);
			}
			if (!firstLine(localPath).includes('VCPN')) {
				throw new Error(`${fileName} sem coluna VCPN no header — formato inesperado`);
			}
			files.push({ fileName, localPath, sizeBytes, sha256: await sha256File(localPath) });
		}

		// Sem mudanca? Nao sobe ~480MB a toa.
		if (current) {
			const currentShas = new Map(current.artifacts.map((artifact) => [artifact.fileName, artifact.sha256]));
			if (files.every((file) => currentShas.get(file.fileName) === file.sha256)) {
				await finishRun({ status: 'skipped-unchanged', rowsSkipped: 1, artifactBatchId: current.batchId });
				fs.rmSync(scratchDir, { recursive: true, force: true });
				return { skipped: true, batchId: current.batchId };
			}
		}

		const batchId = crypto.randomUUID();
		const uploaded = [];
		for (const file of files) {
			const key = store.buildKey({ feed: FEED_NAME, fileName: file.fileName, sha256: file.sha256, at: now() });
			await store.putFile({ key, filePath: file.localPath, contentType: 'text/csv', sizeBytes: file.sizeBytes });
			uploaded.push({ fileName: file.fileName, objectKey: key, sha256: file.sha256, sizeBytes: file.sizeBytes, contentType: 'text/csv' });
		}

		// So aqui o lote vira visivel (os dois uploads ja deram certo).
		await catalog.registerArtifacts(prisma, { feed: FEED_NAME, batchId, source: 'ftp', files: uploaded });

		// Aquece o cache para o proximo seed-all (mesmo layout do materializer).
		const batchDir = path.join(cacheDir, FEED_NAME, batchId);
		fs.mkdirSync(batchDir, { recursive: true });
		for (const file of files) {
			fs.renameSync(file.localPath, path.join(batchDir, file.fileName));
			fs.writeFileSync(path.join(batchDir, `.${file.fileName}.${file.sha256.slice(0, 8)}.ok`), file.sha256);
		}
		fs.rmSync(scratchDir, { recursive: true, force: true });

		await finishRun({ status: 'success', artifactBatchId: batchId });
		return { skipped: false, batchId, files: uploaded };
	} catch (error) {
		await finishRun({ status: 'failed', error: String(error.message || error).slice(0, 4000) });
		throw error;
	}
}

module.exports = { runKeystoneFetch, FEED_NAME, RUN_FEED };
