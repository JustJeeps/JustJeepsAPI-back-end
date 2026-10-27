/* eslint-disable no-console */
// Fetches the JRP feed (explicit FTPS -> Spaces -> catalog). Runs from the
// "feed-fetch-jrp" cron (config/cron-jobs.js) or manually:
//   npm run feed-fetch-jrp
//
// Pure acquisition: it does NOT write to Product/VendorProduct. Consumption
// happens in seed-jrp, which materializes the batch catalogued here.

const prisma = require('../lib/prisma');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { runJrpFetch, createJrpFtpClient } = require('../services/feeds/jrpFetchService');

const BYTES_PER_MB = 1024 * 1024;

async function main() {
	const store = createFeedStore();
	if (!store.isConfigured()) {
		throw new Error('DO_SPACES_* missing from the environment: feed store is not configured');
	}

	const started = Date.now();
	const result = await runJrpFetch({
		// store is passed so an intermediate CA kept in the bucket (and the
		// one recovered through AIA) is found, see lib/feeds/ftpsCa.js
		ftpClient: createJrpFtpClient({ store }),
		store,
		prisma,
	});

	const seconds = ((Date.now() - started) / 1000).toFixed(0);
	if (result.skipped) {
		console.log(`⏭️  JRP feed identical to the current batch (${result.batchId}), nothing to upload (${seconds}s)`);
		return;
	}
	console.log(`✅ Batch ${result.batchId} catalogued with ${result.files.length} file in ${seconds}s`);
	for (const file of result.files) {
		console.log(`   ${file.fileName} (${(file.sizeBytes / BYTES_PER_MB).toFixed(1)}MB) -> ${file.objectKey}`);
	}
}

main()
	.catch((error) => {
		console.error(`❌ JRP feed fetch failed: ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
