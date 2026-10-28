// Fetch of the JRP feed (explicit FTPS, one daily JUSJEE.csv) into the landing
// zone in Spaces. PURE acquisition, the single-file twin of
// keystoneFetchService.js: it downloads, validates, uploads and catalogs, and
// never touches Product/VendorProduct (that is seed-jrp's job).
//
// Guarantees:
//  - sanity gates (minimum size, shrink against the current batch, exact
//    column signature, quote parity on every line) BEFORE cataloguing;
//  - the file is uploaded before the batch is registered, so a failed fetch
//    leaves the previous batch current;
//  - a sha256 equal to the current batch => skip without uploading, recorded
//    as skipped-unchanged;
//  - local cache warmed after cataloguing (the apply does not redownload).
//
// Dependencies are injected for tests without network/DB.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const jrpConfig = require('../../config/jrp');
const { createFtpsClient } = require('../../lib/feeds/ftpsClient');
const { checkCsvQuoteParity } = require('../../lib/feeds/csvIntegrity');
const { hashFile } = require('../../lib/ingest/fileHash');
const { verifyLocalFile } = require('./signatureCheck');

const FEED_NAME = jrpConfig.FEED_ID;
const RUN_FEED = `${FEED_NAME}-fetch`; // heartbeat kept separate from the apply runs
const ENV_PREFIX = 'JRP_FTP';
const LABEL = 'jrp';
const DEFAULT_PORT = 21; // explicit FTPS (AUTH TLS)
const CONTENT_TYPE = 'text/csv';
const MAX_ERROR_LENGTH = 4000;
const DEFAULT_LIMITS = Object.freeze({ minBytes: jrpConfig.MIN_FILE_BYTES, minSizeRatio: jrpConfig.MIN_SIZE_RATIO });
const DEFAULT_CACHE_DIR = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache');

// Host, port, user and password come from env here; the generic client only
// derives tuning names (JRP_FTP_MAX_ATTEMPTS, JRP_FTP_CA_PEM, ...) from the
// prefix. No `defaults` object: the built-in tuning fits a 3MB file.
function createJrpFtpClient({ env = process.env, log = console, createClient = createFtpsClient, ...rest } = {}) {
	const host = String(env.JRP_FTP_HOST || '').trim();
	if (!host) throw new Error(`${ENV_PREFIX}_HOST missing from the environment`);
	const port = Number(env.JRP_FTP_PORT || DEFAULT_PORT);
	if (!Number.isInteger(port) || port <= 0) throw new Error(`${ENV_PREFIX}_PORT must be a port number`);

	return createClient({
		...rest,
		secure: true,
		envPrefix: ENV_PREFIX,
		label: LABEL,
		host,
		port,
		user: env.JRP_FTP_USER || '',
		password: env.JRP_FTP_PASS || '',
		// Always validated: a forged feed would rewrite costs and stock.
		rejectUnauthorized: true,
		env,
		log,
	});
}

// Runs killed mid-flight (a deploy replaces the container) stay "running"
// forever. Only one fetch runs at a time, so anything still running when a
// new one starts was interrupted.
function closeInterruptedRuns(prisma) {
	return prisma.ingestRun.updateMany({
		where: { feed: RUN_FEED, status: 'running' },
		data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted (process ended before finishing)' },
	});
}

function freshScratchDir(cacheDir) {
	const incoming = path.join(cacheDir, 'incoming', FEED_NAME);
	fs.rmSync(incoming, { recursive: true, force: true });
	const scratchDir = path.join(incoming, String(Date.now()));
	fs.mkdirSync(scratchDir, { recursive: true });
	return scratchDir;
}

function assertSize({ fileName, sizeBytes, previousSize, limits }) {
	if (sizeBytes < limits.minBytes) {
		throw new Error(`${fileName} has ${sizeBytes} bytes (< minimum ${limits.minBytes}), truncated download?`);
	}
	if (previousSize && sizeBytes < previousSize * limits.minSizeRatio) {
		throw new Error(
			`${fileName} shrank to ${sizeBytes} bytes (current batch has ${previousSize}, minimum ${Math.round(limits.minSizeRatio * 100)}%), truncated download?`
		);
	}
}

// The header has to be exactly EXPECTED_COLUMNS (config/feeds.js fileSpecs);
// a stitched byte resume keeps size and header but leaves an odd-quote line
// that makes every downstream csv-parser buffer the rest of the file.
async function assertStructure({ fileName, localPath, feedsConfig }) {
	const signature = verifyLocalFile(localPath, { feed: FEED_NAME, fileName, feedsConfig });
	if (!signature.ok) throw new Error(`${fileName} has an unexpected header. ${signature.message}`);
	const parity = await checkCsvQuoteParity(localPath);
	if (parity.oddQuoteLines > 0) {
		throw new Error(
			`${fileName} has ${parity.oddQuoteLines} line(s) with an odd number of quotes (first at line ${parity.firstOddQuoteLine}), corrupted download?`
		);
	}
}

async function downloadAndValidate({ ftpClient, fileName, scratchDir, current, limits, feedsConfig }) {
	const localPath = path.join(scratchDir, fileName);
	const { modifiedAt = null } = (await ftpClient.downloadFile(fileName, localPath)) || {};
	const sizeBytes = fs.statSync(localPath).size;
	const previous = (current?.artifacts || []).find((artifact) => artifact.fileName === fileName);
	assertSize({ fileName, sizeBytes, previousSize: previous ? Number(previous.sizeBytes) : 0, limits });
	await assertStructure({ fileName, localPath, feedsConfig });
	return { fileName, localPath, sizeBytes, sourceModifiedAt: modifiedAt, sha256: await hashFile(localPath) };
}

function isUnchanged(current, file) {
	if (!current) return false;
	return current.artifacts.some((artifact) => artifact.fileName === file.fileName && artifact.sha256 === file.sha256);
}

async function uploadFile({ store, file, now }) {
	const key = store.buildKey({ feed: FEED_NAME, fileName: file.fileName, sha256: file.sha256, at: now() });
	await store.putFile({ key, filePath: file.localPath, contentType: CONTENT_TYPE, sizeBytes: file.sizeBytes });
	return {
		fileName: file.fileName,
		objectKey: key,
		sha256: file.sha256,
		sizeBytes: file.sizeBytes,
		contentType: CONTENT_TYPE,
		sourceModifiedAt: file.sourceModifiedAt,
	};
}

// Same layout and sentinel as lib/feeds/materialize.js, so the apply finds it.
function warmCache({ cacheDir, batchId, file }) {
	const batchDir = path.join(cacheDir, FEED_NAME, batchId);
	fs.mkdirSync(batchDir, { recursive: true });
	fs.renameSync(file.localPath, path.join(batchDir, file.fileName));
	fs.writeFileSync(path.join(batchDir, `.${file.fileName}.${file.sha256.slice(0, 8)}.ok`), file.sha256);
}

async function fetchAndCatalog({ ftpClient, store, prisma, catalog, feedsConfig, cacheDir, limits, now, finishRun }) {
	const [fileName] = feedsConfig.getFeedByName(FEED_NAME).files;
	const scratchDir = freshScratchDir(cacheDir);
	const current = await catalog.getCurrentBatch(prisma, FEED_NAME, [fileName]);
	const file = await downloadAndValidate({ ftpClient, fileName, scratchDir, current, limits, feedsConfig });

	if (isUnchanged(current, file)) {
		await finishRun({ status: 'skipped-unchanged', rowsSkipped: 1, artifactBatchId: current.batchId });
		fs.rmSync(scratchDir, { recursive: true, force: true });
		return { skipped: true, batchId: current.batchId };
	}

	const batchId = crypto.randomUUID();
	const uploaded = await uploadFile({ store, file, now });
	// Only here does the batch become visible (the upload already succeeded).
	await catalog.registerArtifacts(prisma, { feed: FEED_NAME, batchId, source: 'ftp', files: [uploaded] });
	warmCache({ cacheDir, batchId, file });
	fs.rmSync(scratchDir, { recursive: true, force: true });

	await finishRun({ status: 'success', artifactBatchId: batchId });
	return { skipped: false, batchId, files: [uploaded] };
}

async function runJrpFetch({
	ftpClient,
	store,
	prisma,
	catalog = require('../../lib/feeds/catalog'),
	feedsConfig = require('../../config/feeds'),
	cacheDir = DEFAULT_CACHE_DIR,
	limits = DEFAULT_LIMITS,
	now = () => new Date(),
}) {
	await closeInterruptedRuns(prisma);
	const run = await prisma.ingestRun.create({
		data: { feed: RUN_FEED, sourceKind: 'ftp', sourceRef: feedsConfig.getFeedByName(FEED_NAME).files.join('+') },
	});
	const finishRun = (data) => prisma.ingestRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ...data } });

	try {
		const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
		return await fetchAndCatalog({ ftpClient, store, prisma, catalog, feedsConfig, cacheDir, limits: effectiveLimits, now, finishRun });
	} catch (error) {
		await finishRun({ status: 'failed', error: String(error.message || error).slice(0, MAX_ERROR_LENGTH) });
		throw error;
	}
}

module.exports = { runJrpFetch, createJrpFtpClient, FEED_NAME, RUN_FEED };
