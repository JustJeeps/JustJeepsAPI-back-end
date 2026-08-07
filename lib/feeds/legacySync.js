// Syncs the feeds from the catalog/Spaces to the LEGACY PATHS in
// prisma/seeds/api-calls, so the seeds keep reading the usual paths (zero diff
// in the scripts) but the file behind them is a symlink to the current batch
// in the verified cache of the materializer.
//
// legacyDir is RESOLVED, not joined: most feeds give a path relative to
// api-calls, but a consumer that reads from somewhere else entirely (the
// QuickBooks lookup reads its own volume) gives an absolute one, and join would
// silently treat it as relative and drop the link in the wrong place.
//
// Semantics per feed:
//   complete batch in the catalog -> materialize + atomic symlink (synced)
//   no batch (FEED_NO_ARTIFACT)   -> warn and keep the existing file (baked
//                                    into the image) during the transition (skipped)
//   any other failure             -> failed (feed-sync exits with 1; visible)
//
// Swapping the symlink is atomic: it creates a temporary link and renames it
// over the old one, so readers never see a broken path mid swap.

const fs = require('fs');
const path = require('path');

// Creates/updates a symlink at linkPath pointing to targetPath (absolute).
// Replaces a pre-existing regular file (the one baked into the image) via rename.
function ensureLink(linkPath, targetPath) {
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });

	try {
		if (fs.readlinkSync(linkPath) === targetPath) return false; // already points to the right place
	} catch {
		// does not exist or is not a symlink, so go ahead with the swap
	}

	const tmpLink = `${linkPath}.tmp-${process.pid}`;
	fs.rmSync(tmpLink, { force: true });
	fs.symlinkSync(targetPath, tmpLink);
	fs.renameSync(tmpLink, linkPath);
	return true;
}

function createLegacySync({
	materializer,
	feedsConfig = require('../../config/feeds'),
	apiCallsDir = path.join(__dirname, '../../prisma/seeds/api-calls'),
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	logger = console,
} = {}) {
	// Removes only the symlinks we created (the ones pointing to the feed cache).
	// A regular file in the legacy path is never touched.
	function removeOwnLinks(feed) {
		let removed = 0;
		for (const fileName of feed.files) {
			const linkPath = path.resolve(apiCallsDir, feed.legacyDir || '', fileName);
			try {
				if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath).startsWith(cacheDir)) {
					fs.rmSync(linkPath, { force: true });
					removed += 1;
				}
			} catch {
				// path does not exist: nothing to remove
			}
		}
		return removed;
	}

	async function syncFeed(feed) {
		const materialized = await materializer.materializeFeed(feed.name);
		const links = [];
		for (const fileName of feed.files) {
			const linkPath = path.resolve(apiCallsDir, feed.legacyDir || '', fileName);
			const changed = ensureLink(linkPath, materialized.files[fileName]);
			links.push({ fileName, linkPath, target: materialized.files[fileName], changed });
		}
		return { feed: feed.name, batchId: materialized.batchId, stale: materialized.stale, links };
	}

	// Processes every feed in the registry; a failure in one does not stop the rest.
	async function syncAllFeeds() {
		const synced = [];
		const skipped = [];
		const failed = [];

		for (const feed of feedsConfig.getFeedDefinitions()) {
			try {
				const result = await syncFeed(feed);
				synced.push(result);
				logger.log(
					`🔗 [feed-sync] ${feed.name}: batch ${result.batchId}${result.stale ? ' (STALE)' : ''} -> ${feed.files.length} file(s) in api-calls/${feed.legacyDir || '.'}`
				);
			} catch (error) {
				if (error.code === 'FEED_NO_ARTIFACT') {
					// No current batch (new feed, or the batch was quarantined).
					// If the legacy path is still OUR symlink, it points to the
					// batch that went out of circulation: remove it, so the seed
					// fails loudly instead of reingesting the condemned file. If it
					// is a regular file (baked into the image), we keep it, since
					// that is the transition.
					const removed = removeOwnLinks(feed);
					skipped.push({ feed: feed.name, reason: error.message, removedLinks: removed });
					logger.warn(removed > 0
						? `⚠️ [feed-sync] ${feed.name}: no batch in the catalog, ${removed} link(s) from the previous batch removed; the seed will fail until a new file is uploaded`
						: `⚠️ [feed-sync] ${feed.name}: no batch in the catalog, keeping the existing local file`);
				} else {
					failed.push({ feed: feed.name, code: error.code || null, error: error.message });
					logger.error(`❌ [feed-sync] ${feed.name}: ${error.message}`);
				}
			}
		}

		return { synced, skipped, failed };
	}

	return { syncFeed, syncAllFeeds };
}

module.exports = { createLegacySync, ensureLink };
