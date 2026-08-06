/* eslint-disable no-console */
// Fetches the Keystone feeds (FTP -> Spaces -> catalog). Runs from the
// "feed-fetch-keystone" cron (config/cron-jobs.js) or manually:
//   npm run feed-fetch-keystone
//
// Pure acquisition: it does NOT write to Product/VendorProduct. Consumption
// happens in seed-keystone-ftp2 on the next seed-all round, which materializes
// the batch catalogued here.

const prisma = require('../lib/prisma');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { createKeystoneFtpClient } = require('../lib/feeds/keystoneFtp');
const { runKeystoneFetch } = require('../services/feeds/keystoneFetchService');

async function main() {
	const store = createFeedStore();
	if (!store.isConfigured()) {
		throw new Error('DO_SPACES_* missing from the environment: feed store is not configured');
	}

	const started = Date.now();
	const result = await runKeystoneFetch({
		// store is passed here because the intermediate CA for the Keystone FTPS
		// lives in a private directory of the bucket (not in the repository),
		// see lib/feeds/keystoneFtp.js
		ftpClient: createKeystoneFtpClient({ store }),
		store,
		prisma,
	});

	const seconds = ((Date.now() - started) / 1000).toFixed(0);
	if (result.skipped) {
		console.log(`⏭️  Keystone feeds identical to the current batch (${result.batchId}), nothing to upload (${seconds}s)`);
	} else {
		console.log(`✅ Batch ${result.batchId} catalogued with ${result.files.length} files in ${seconds}s`);
		for (const file of result.files) {
			console.log(`   ${file.fileName} (${(file.sizeBytes / 1024 / 1024).toFixed(1)}MB) -> ${file.objectKey}`);
		}
	}
}

main()
	.catch((error) => {
		console.error(`❌ Keystone feed fetch failed: ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
