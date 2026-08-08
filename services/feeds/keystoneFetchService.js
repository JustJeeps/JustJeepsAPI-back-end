// Fetch of the Keystone feeds (FTP) into the landing zone in Spaces. PURE
// acquisition: it downloads, validates, uploads and catalogs, and never
// touches Product/VendorProduct (that is seed-keystone-ftp2's job in the next
// seed-all round).
//
// Guarantees:
//  - sanity gates (minimum size + VCPN header) BEFORE cataloguing;
//  - BOTH files are uploaded before the batch is registered (a partial upload
//    catalogs nothing, so the previous batch stays current);
//  - hashes equal to the current batch => skip without uploading (saves a
//    ~460MB PUT), recorded as skipped-unchanged;
//  - local cache warmed after cataloguing (the next seed-all does not
//    redownload).
//
// Dependencies are injected for tests without network/DB.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FEED_NAME = 'keystone-ftp';
const RUN_FEED = 'keystone-ftp-fetch'; // heartbeat kept separate from the consumption rounds

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
	// The consumer (seed-keystone-ftp2) runs with staleStrategy "delete": a
	// truncated download that gets past the fixed floor would erase the missing
	// rows. That is why the real gate compares against the current batch.
	const minRatioVsCurrent = Number(env.KEYSTONE_FTP_MIN_SIZE_RATIO || 0.9);

	// Runs killed mid-flight (a deploy replaces the container) stay as "running"
	// forever and the panel keeps showing a fetch that is not happening. Only one
	// fetch runs at a time, so anything still marked running when a new one
	// starts is an interrupted run.
	await prisma.ingestRun.updateMany({
		where: { feed: RUN_FEED, status: 'running' },
		data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted (process ended before finishing)' },
	});

	const run = await prisma.ingestRun.create({
		data: { feed: RUN_FEED, sourceKind: 'ftp', sourceRef: feed.files.join('+') },
	});
	const finishRun = (data) => prisma.ingestRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ...data } });

	try {
		// New scratch dir per execution; the whole incoming/ tree is disposable.
		const scratchDir = path.join(cacheDir, 'incoming', FEED_NAME, String(Date.now()));
		fs.rmSync(path.join(cacheDir, 'incoming', FEED_NAME), { recursive: true, force: true });
		fs.mkdirSync(scratchDir, { recursive: true });

		const current = await catalog.getCurrentBatch(prisma, FEED_NAME, feed.files);
		const currentSizes = new Map((current?.artifacts || []).map((artifact) => [artifact.fileName, Number(artifact.sizeBytes)]));

		const files = [];
		for (const fileName of feed.files) {
			const localPath = path.join(scratchDir, fileName);
			const { modifiedAt = null } = (await ftpClient.downloadFile(fileName, localPath)) || {};

			const sizeBytes = fs.statSync(localPath).size;
			if (sizeBytes < minBytes[fileName]) {
				throw new Error(`${fileName} has ${sizeBytes} bytes (< minimum ${minBytes[fileName]}), truncated download?`);
			}
			const previousSize = currentSizes.get(fileName);
			if (previousSize && sizeBytes < previousSize * minRatioVsCurrent) {
				throw new Error(
					`${fileName} shrank to ${sizeBytes} bytes (current batch has ${previousSize}, minimum ${Math.round(minRatioVsCurrent * 100)}%), truncated download?`
				);
			}
			if (!firstLine(localPath).includes('VCPN')) {
				throw new Error(`${fileName} has no VCPN column in the header, unexpected format`);
			}
			// The vendor's own date, so the panel can tell today's export from
			// yesterday's instead of dating the file by when we fetched it.
			files.push({ fileName, localPath, sizeBytes, sourceModifiedAt: modifiedAt, sha256: await sha256File(localPath) });
		}

		// Nothing changed? Do not upload ~480MB for nothing.
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
			uploaded.push({ fileName: file.fileName, objectKey: key, sha256: file.sha256, sizeBytes: file.sizeBytes, contentType: 'text/csv', sourceModifiedAt: file.sourceModifiedAt });
		}

		// Only here does the batch become visible (both uploads already succeeded).
		await catalog.registerArtifacts(prisma, { feed: FEED_NAME, batchId, source: 'ftp', files: uploaded });

		// Warms the cache for the next seed-all (same layout as the materializer).
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
