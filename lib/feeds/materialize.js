// Materializa um feed do catalogo/Spaces num diretorio de cache local e
// devolve caminhos com os nomes CANONICOS que os seeds esperam — o consumidor
// troca so a linha que resolve o diretorio, o parsing fica intacto.
//
// Cache: FEED_CACHE_DIR/{feed}/{batchId}/{fileName} + sentinela
// .{fileName}.{sha8}.ok gravada apos verificar o sha256 do download. Batch em
// cache com sentinela = zero download no proximo run (SpecialOrder tem 460MB).
//
// Falhas sao SEMPRE explicitas (nunca sucesso silencioso — o caso seed-omix):
//   FEED_UNKNOWN            feed fora do config/feeds.js
//   FEED_NO_ARTIFACT        catalogo sem lote completo para o feed
//   FEED_HASH_MISMATCH      download nao bate com o sha256 do catalogo (2x)
//   FEED_STALE              lote mais velho que staleAfterHours (so com requireFresh)
//   FEED_STORE_UNAVAILABLE  Spaces fora E nenhum lote completo em cache
// Spaces fora + lote anterior completo em disco => serve o antigo com
// stale=true e warning alto (degradacao explicita, igual load-workbook avisa
// planilha velha).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_KEEP_BATCHES = Number(process.env.FEED_CACHE_KEEP_BATCHES || 2);
// Uma linha de progresso a cada 10MB: da ritmo visivel num arquivo de 460MB
// sem inundar o log de um arquivo de 200KB.
const PROGRESS_STEP_BYTES = Number(process.env.FEED_DOWNLOAD_PROGRESS_STEP_BYTES || 10 * 1024 * 1024);
const formatMb = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`;

function typedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

const sentinelName = (fileName, sha256) => `.${fileName}.${sha256.slice(0, 8)}.ok`;

function isFileCached(batchDir, artifact) {
	const filePath = path.join(batchDir, artifact.fileName);
	const okPath = path.join(batchDir, sentinelName(artifact.fileName, artifact.sha256));
	if (!fs.existsSync(filePath) || !fs.existsSync(okPath)) return false;
	// Sanidade barata: tamanho precisa bater (o sha ja foi verificado no download).
	return fs.statSync(filePath).size === Number(artifact.sizeBytes);
}

async function downloadVerified(store, artifact, batchDir) {
	const finalPath = path.join(batchDir, artifact.fileName);
	const partialPath = `${finalPath}.partial`;

	const attempt = async () => {
		const { body } = await store.getObjectStream(artifact.objectKey);
		const hash = crypto.createHash('sha256');
		const totalBytes = Number(artifact.sizeBytes) || 0;
		let receivedBytes = 0;
		let nextReportAt = PROGRESS_STEP_BYTES;

		// Feeds grandes (SpecialOrder tem ~460MB) levam minutos. Sem estas linhas
		// o log fica MUDO durante o download inteiro e quem acompanha pelo painel
		// nao distingue "baixando" de "travado".
		console.log(`⬇️ [feeds] baixando ${artifact.fileName} (${formatMb(totalBytes)})...`);

		await new Promise((resolve, reject) => {
			const out = fs.createWriteStream(partialPath);
			body.on('data', (chunk) => {
				hash.update(chunk);
				receivedBytes += chunk.length;
				if (receivedBytes >= nextReportAt) {
					nextReportAt = receivedBytes + PROGRESS_STEP_BYTES;
					const pct = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : null;
					console.log(
						`⬇️ [feeds] ${artifact.fileName} ${pct === null ? '' : `${pct}% `}(${formatMb(receivedBytes)} de ${formatMb(totalBytes)})`
					);
				}
			});
			body.on('error', reject);
			out.on('error', reject);
			out.on('finish', resolve);
			body.pipe(out);
		});

		console.log(`✅ [feeds] ${artifact.fileName} baixado (${formatMb(receivedBytes)}), verificando hash...`);
		return hash.digest('hex');
	};

	for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
		const digest = await attempt();
		if (digest === artifact.sha256) {
			fs.renameSync(partialPath, finalPath);
			fs.writeFileSync(path.join(batchDir, sentinelName(artifact.fileName, artifact.sha256)), digest);
			return;
		}
		fs.rmSync(partialPath, { force: true });
		console.warn(`⚠️ [feeds] hash mismatch em ${artifact.objectKey} (tentativa ${attemptNumber})`);
	}
	throw typedError(
		'FEED_HASH_MISMATCH',
		`Download de ${artifact.objectKey} nao bate com o sha256 do catalogo apos 2 tentativas`
	);
}

// Lote anterior completo em disco (todas as sentinelas presentes), mais
// recente primeiro — fallback quando o Spaces esta fora.
function findIntactCachedBatch(feedDir, expectedFileNames, excludeBatchId) {
	if (!fs.existsSync(feedDir)) return null;
	const candidates = fs.readdirSync(feedDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== excludeBatchId)
		.map((entry) => ({ batchId: entry.name, dir: path.join(feedDir, entry.name) }))
		.map((candidate) => ({ ...candidate, mtimeMs: fs.statSync(candidate.dir).mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const candidate of candidates) {
		const entries = fs.readdirSync(candidate.dir);
		const complete = expectedFileNames.every((fileName) =>
			entries.includes(fileName) &&
			entries.some((entry) => entry.startsWith(`.${fileName}.`) && entry.endsWith('.ok')));
		if (complete) return candidate;
	}
	return null;
}

function pruneOldBatches(feedDir, keepBatchIds, keepCount) {
	if (!fs.existsSync(feedDir)) return;
	const dirs = fs.readdirSync(feedDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({ name: entry.name, mtimeMs: fs.statSync(path.join(feedDir, entry.name)).mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const keep = new Set(keepBatchIds);
	dirs.forEach((dir, index) => {
		if (index >= keepCount && !keep.has(dir.name)) {
			fs.rmSync(path.join(feedDir, dir.name), { recursive: true, force: true });
		}
	});
}

function createMaterializer({
	store,
	prisma,
	feedsConfig = require('../../config/feeds'),
	catalog = require('./catalog'),
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	keepBatches = DEFAULT_KEEP_BATCHES,
	now = () => new Date(),
} = {}) {
	async function materializeFeed(feedName, { requireFresh = false } = {}) {
		const feed = feedsConfig.getFeedByName(feedName);
		if (!feed) throw typedError('FEED_UNKNOWN', `Feed desconhecido: ${feedName} (config/feeds.js)`);

		const batch = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		if (!batch) {
			throw typedError(
				'FEED_NO_ARTIFACT',
				`Nenhum lote completo catalogado para o feed ${feed.name} — suba via painel /settings ou "npm run feed-upload -- ${feed.name} <arquivos>"`
			);
		}

		const feedDir = path.join(cacheDir, feed.name);
		const batchDir = path.join(feedDir, batch.batchId);
		fs.mkdirSync(batchDir, { recursive: true });

		let servedBatch = batch;
		let servedDir = batchDir;
		let degraded = false;

		try {
			for (const artifact of batch.artifacts) {
				if (!isFileCached(batchDir, artifact)) {
					await downloadVerified(store, artifact, batchDir);
				}
			}
		} catch (error) {
			if (error.code === 'FEED_HASH_MISMATCH') throw error;
			// Spaces indisponivel: degrada para o ultimo lote completo em disco.
			const fallback = findIntactCachedBatch(feedDir, feed.files, batch.batchId);
			if (!fallback) {
				throw typedError(
					'FEED_STORE_UNAVAILABLE',
					`Spaces indisponivel para o feed ${feed.name} e nenhum lote completo em cache: ${error.message}`
				);
			}
			console.warn(
				`⚠️ [feeds] Spaces indisponivel (${error.message}); usando lote em cache ${fallback.batchId} do feed ${feed.name} (DADO POSSIVELMENTE VELHO)`
			);
			servedBatch = { batchId: fallback.batchId, uploadedAt: null, artifacts: [] };
			servedDir = fallback.dir;
			degraded = true;
		}

		const ageHours = servedBatch.uploadedAt ? (now() - servedBatch.uploadedAt) / 36e5 : null;
		const stale = degraded || (ageHours !== null && ageHours > feed.staleAfterHours);
		if (stale && !degraded) {
			console.warn(
				`⚠️ [feeds] Lote do feed ${feed.name} tem ${ageHours.toFixed(1)}h (limite ${feed.staleAfterHours}h) — pode nao ser o feed atual`
			);
		}
		if (stale && requireFresh) {
			throw typedError('FEED_STALE', `Feed ${feed.name} esta stale (${ageHours === null ? 'idade desconhecida' : `${ageHours.toFixed(1)}h`})`);
		}

		if (!degraded) pruneOldBatches(feedDir, [servedBatch.batchId], keepBatches);

		const files = {};
		for (const fileName of feed.files) {
			files[fileName] = path.join(servedDir, fileName);
		}

		return { dir: servedDir, files, batchId: servedBatch.batchId, ageHours, stale };
	}

	return { materializeFeed };
}

// Shim sincrono para pontos de resolucao sincronos dos seeds (consts de
// modulo, loadWorkbook). Spawna scripts/feed-materialize.js num processo
// curto com pool minimo — cache quente custa ~1s de startup do node.
function materializeFeedSync(feedName) {
	const output = execFileSync(
		process.execPath,
		[path.join(__dirname, '../../scripts/feed-materialize.js'), feedName, '--json'],
		{
			env: { ...process.env, APP_ROLE: 'seed', DB_POOL_SEED: '1' },
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'inherit'],
		}
	);
	const jsonLine = output.trim().split('\n').pop();
	return JSON.parse(jsonLine);
}

module.exports = { createMaterializer, materializeFeedSync };
