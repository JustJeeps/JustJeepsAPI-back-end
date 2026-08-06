/* eslint-disable no-console */
// Materializes a feed from the catalog/Spaces into the local cache and prints
// the result.
// Usage: node scripts/feed-materialize.js <feed> [--json]
//
// With --json the stdout output is ONE JSON line (warnings go to stderr): that
// is the contract of the materializeFeedSync() shim in lib/feeds/materialize.js.

const prisma = require('../lib/prisma');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { createMaterializer } = require('../lib/feeds/materialize');

async function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes('--json');
	const feedName = args.find((arg) => !arg.startsWith('--'));

	if (!feedName) {
		console.error('Usage: node scripts/feed-materialize.js <feed> [--json]');
		process.exitCode = 1;
		return;
	}

	const store = createFeedStore();
	if (!store.isConfigured()) {
		console.error('DO_SPACES_* missing from the environment: feed store is not configured');
		process.exitCode = 1;
		return;
	}

	const materializer = createMaterializer({ store, prisma });
	const result = await materializer.materializeFeed(feedName);

	if (asJson) {
		console.log(JSON.stringify(result));
	} else {
		console.log(`✅ Feed ${feedName} materialized at ${result.dir} (batch ${result.batchId}${result.stale ? ', STALE' : ''})`);
		for (const [fileName, filePath] of Object.entries(result.files)) {
			console.log(`   ${fileName} -> ${filePath}`);
		}
	}
}

main()
	.catch((error) => {
		console.error(`❌ ${error.code || 'ERROR'}: ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
