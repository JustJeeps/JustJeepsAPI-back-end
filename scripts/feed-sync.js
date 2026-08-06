/* eslint-disable no-console */
// Syncs the feeds from the catalog/Spaces into the legacy paths under
// prisma/seeds/api-calls (symlink -> verified cache). Runs as stage 0 of
// seed-all and manually:
//   npm run feed-sync            every feed (tolerant mode)
//   npm run feed-sync -- <feed>  a single feed (STRICT mode)
//
// Exit codes: 0 = ok. 1 = failure. In "all" mode a feed with no batch is only a
// warning (transition period: the existing local file still counts). In single
// feed mode, used by the "Run now" button before running the seed, a feed with
// no batch is a FAILURE: whoever asked to run that feed expects the file from
// the catalog.

const prisma = require('../lib/prisma');
const feedsConfig = require('../config/feeds');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { createMaterializer } = require('../lib/feeds/materialize');
const { createLegacySync } = require('../lib/feeds/legacySync');

async function main() {
	const onlyFeed = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
	const store = createFeedStore();
	if (!store.isConfigured()) {
		const message = 'DO_SPACES_* missing: feed store is not configured';
		if (onlyFeed) throw new Error(message);
		console.warn(`⚠️ [feed-sync] ${message}; sync skipped, seeds will use the existing local files`);
		return;
	}

	const materializer = createMaterializer({ store, prisma });
	const sync = createLegacySync({ materializer });

	if (onlyFeed) {
		const feed = feedsConfig.getFeedByName(onlyFeed);
		if (!feed) throw new Error(`Unknown feed: ${onlyFeed}`);
		const result = await sync.syncFeed(feed); // throws on any failure (strict mode)
		console.log(`🔗 [feed-sync] ${feed.name}: batch ${result.batchId}${result.stale ? ' (STALE)' : ''} ready at api-calls/${feed.legacyDir || '.'}`);
		return;
	}

	const { synced, skipped, failed } = await sync.syncAllFeeds();

	console.log(
		`\n📦 [feed-sync] ${synced.length} synced, ${skipped.length} with no batch (local file kept), ${failed.length} failure(s)`
	);
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

main()
	.catch((error) => {
		console.error(`❌ [feed-sync] ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
