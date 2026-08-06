// Materializes a feed from the catalog/Spaces into a local cache directory and
// returns paths with the CANONICAL names the seeds expect, so the consumer
// only swaps the line that resolves the directory and the parsing stays intact.
//
// Cache: FEED_CACHE_DIR/{feed}/{batchId}/{fileName} + sentinel
// .{fileName}.{sha8}.ok written after verifying the sha256 of the download. A
// cached batch with its sentinel = zero downloads on the next run
// (SpecialOrder is 460MB).
//
// Failures are ALWAYS explicit (never a silent success, the seed-omix case):
//   FEED_UNKNOWN            feed not in config/feeds.js
//   FEED_NO_ARTIFACT        catalog has no complete batch for the feed
//   FEED_HASH_MISMATCH      download does not match the catalog sha256 (2x)
//   FEED_STALE              batch older than staleAfterHours (only with requireFresh)
//   FEED_STORE_UNAVAILABLE  Spaces down AND no complete batch in cache
// Spaces down + previous complete batch on disk => serves the old one with
// stale=true and a loud warning (explicit degradation, the same way
// load-workbook warns about an old spreadsheet).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_KEEP_BATCHES = Number(process.env.FEED_CACHE_KEEP_BATCHES || 2);
// One progress line every 10MB: gives visible pace on a 460MB file without
// flooding the log for a 200KB file.
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
	// Cheap sanity check: the size has to match (the sha was already verified on download).
	return fs.statSync(filePath).size === Number(artifact.sizeBytes);
}

async function downloadVerified(store, artifact, batchDir, log) {
	const finalPath = path.join(batchDir, artifact.fileName);
	const partialPath = `${finalPath}.partial`;

	const attempt = async () => {
		const { body } = await store.getObjectStream(artifact.objectKey);
		const hash = crypto.createHash('sha256');
		const totalBytes = Number(artifact.sizeBytes) || 0;
		let receivedBytes = 0;
		let nextReportAt = PROGRESS_STEP_BYTES;

		// Big feeds (SpecialOrder is ~460MB) take minutes. Without these lines the
		// log stays SILENT during the whole download and whoever is watching from
		// the panel cannot tell "downloading" from "stuck".
		log.log(`⬇️ [feeds] downloading ${artifact.fileName} (${formatMb(totalBytes)})...`);

		await new Promise((resolve, reject) => {
			const out = fs.createWriteStream(partialPath);
			body.on('data', (chunk) => {
				hash.update(chunk);
				receivedBytes += chunk.length;
				if (receivedBytes >= nextReportAt) {
					nextReportAt = receivedBytes + PROGRESS_STEP_BYTES;
					const pct = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : null;
					log.log(
						`⬇️ [feeds] ${artifact.fileName} ${pct === null ? '' : `${pct}% `}(${formatMb(receivedBytes)} of ${formatMb(totalBytes)})`
					);
				}
			});
			body.on('error', reject);
			out.on('error', reject);
			out.on('finish', resolve);
			body.pipe(out);
		});

		log.log(`✅ [feeds] ${artifact.fileName} downloaded (${formatMb(receivedBytes)}), verifying hash...`);
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
		log.warn(`⚠️ [feeds] hash mismatch on ${artifact.objectKey} (attempt ${attemptNumber})`);
	}
	throw typedError(
		'FEED_HASH_MISMATCH',
		`Download of ${artifact.objectKey} does not match the catalog sha256 after 2 attempts`
	);
}

// Previous complete batch on disk (all sentinels present), most recent first,
// used as the fallback when Spaces is down.
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
	// Injectable so the tests do not print megabytes of progress lines (which
	// also keeps the node test runner from tripping over interleaved output).
	log = console,
} = {}) {
	async function materializeFeed(feedName, { requireFresh = false } = {}) {
		const feed = feedsConfig.getFeedByName(feedName);
		if (!feed) throw typedError('FEED_UNKNOWN', `Unknown feed: ${feedName} (config/feeds.js)`);

		const batch = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		if (!batch) {
			throw typedError(
				'FEED_NO_ARTIFACT',
				`No complete batch catalogued for feed ${feed.name}: upload it from the /settings panel or run "npm run feed-upload -- ${feed.name} <files>"`
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
					await downloadVerified(store, artifact, batchDir, log);
				}
			}
		} catch (error) {
			if (error.code === 'FEED_HASH_MISMATCH') throw error;
			// Spaces unavailable: degrade to the last complete batch on disk.
			const fallback = findIntactCachedBatch(feedDir, feed.files, batch.batchId);
			if (!fallback) {
				throw typedError(
					'FEED_STORE_UNAVAILABLE',
					`Spaces unavailable for feed ${feed.name} and no complete batch in cache: ${error.message}`
				);
			}
			log.warn(
				`⚠️ [feeds] Spaces unavailable (${error.message}); using cached batch ${fallback.batchId} of feed ${feed.name} (DATA MAY BE OUT OF DATE)`
			);
			servedBatch = { batchId: fallback.batchId, uploadedAt: null, artifacts: [] };
			servedDir = fallback.dir;
			degraded = true;
		}

		const ageHours = servedBatch.uploadedAt ? (now() - servedBatch.uploadedAt) / 36e5 : null;
		const stale = degraded || (ageHours !== null && ageHours > feed.staleAfterHours);
		if (stale && !degraded) {
			log.warn(
				`⚠️ [feeds] Batch of feed ${feed.name} is ${ageHours.toFixed(1)}h old (limit ${feed.staleAfterHours}h), it may not be the current feed`
			);
		}
		if (stale && requireFresh) {
			throw typedError('FEED_STALE', `Feed ${feed.name} is stale (${ageHours === null ? 'unknown age' : `${ageHours.toFixed(1)}h`})`);
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

// Synchronous shim for the synchronous resolution points in the seeds (module
// level consts, loadWorkbook). Spawns scripts/feed-materialize.js in a short
// lived process with a minimal pool; on a warm cache it costs about 1s of node
// startup.
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
