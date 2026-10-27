/* prisma/seeds/seed-individual/seed-jrp.js */
// JRP apply: the catalogued JUSJEE.csv (feed jrp-ftp) into VendorProduct.
// Usage: npm run seed-jrp [-- --dry-run] [-- --force]
//   --dry-run  gates + matching + counts, reads only (no write, no upload, no IngestRun)
//   --force    evaluate even when the file equals the last successful run
// The logic lives in lib/feeds/jrp/jrpIngest.js; this file only wires it.

const { FEED_ID } = require('../../../config/jrp');

function parseArgs(argv) {
	return { dryRun: argv.includes('--dry-run'), force: argv.includes('--force') };
}

const exitCodeFor = (result) => (result.status === 'failed' ? 1 : 0);

function buildDeps() {
	const prisma = require('../../../lib/prisma');
	const { createFeedStore } = require('../../../lib/feeds/feedStore');
	const { createMaterializer } = require('../../../lib/feeds/materialize');
	const catalog = require('../../../lib/feeds/catalog');
	const { hashFile } = require('../../../lib/ingest/fileHash');
	const { startRun, isUnchanged } = require('../../../lib/ingest/ingestRun');
	const { acquireIngestLock, releaseIngestLock } = require('../../../lib/ingest/runLock');
	const stageTable = require('../../../lib/ingest/stageTable');
	const { diffApply } = require('../../../lib/ingest/diffApply');

	const store = createFeedStore();
	const materializer = createMaterializer({ store, prisma });
	const deps = {
		prisma,
		store,
		materialize: (feed) => materializer.materializeFeed(feed),
		getCurrentBatch: catalog.getCurrentBatch,
		hashFile,
		ingestRun: { startRun, isUnchanged },
		lock: { acquire: acquireIngestLock, release: releaseIngestLock },
		stage: {
			ensureTable: stageTable.ensureStagingTable,
			insertBatch: stageTable.insertBatch,
			query: stageTable.queryStaging,
			close: stageTable.closePool,
		},
		diffApply,
		vendorsPrefix: require('../hard-code_data/vendors_prefix'),
		env: process.env,
		now: () => new Date(),
		log: console,
	};
	return { prisma, deps };
}

async function main(argv = process.argv.slice(2), { build = buildDeps, run, log = console } = {}) {
	const runIngest = run || require('../../../lib/feeds/jrp/jrpIngest').runJrpIngest;
	const options = parseArgs(argv);
	const { prisma, deps } = build();
	try {
		if (!options.dryRun && !deps.store.isConfigured()) {
			log.error(`[jrp] DO_SPACES_* missing: the ${FEED_ID} feed store is not configured`);
			return 1;
		}
		return exitCodeFor(await runIngest(deps, options));
	} catch (error) {
		log.error('[jrp] unexpected failure:', error);
		return 1;
	} finally {
		await prisma.$disconnect();
	}
}

if (require.main === module) {
	main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, exitCodeFor, main };
