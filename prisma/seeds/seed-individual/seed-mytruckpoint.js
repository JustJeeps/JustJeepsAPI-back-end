// MyTruckPoint competitor prices (DD-022). Thin entry: the run is the shared
// Shopify competitor run (services/competitors/shopifyCompetitorRun.js) bound
// to the MyTruckPoint profile. The brands come from the rows of
// vendors_prefix.js that carry mytruckpoint_code and mytruckpoint_sku_prefixes.
//
//   npm run seed-mytruckpoint                                   # collect + write
//   npm run seed-mytruckpoint -- --dry-run                      # collect + match report, no writes
//   npm run seed-mytruckpoint -- --collect-only                 # collect + snapshot, never opens the database
//   npm run seed-mytruckpoint -- --brands=BIL,WAR --max-pages=2 # sample run (skips the size floors)
//   npm run seed-mytruckpoint -- --from-snapshot <file>         # ingest a saved snapshot (.json.gz), no network
//
// Exit codes: 0 success, 1 failed (nothing written, except
// MYTRUCKPOINT_WRITE_FAILED and MYTRUCKPOINT_RUN_NOT_RECORDED, which say what
// was), 2 partial (written, the crawl stopped on its budget). Nothing is ever
// deleted: rows not seen are counted and reported.

const path = require('path');

const { createCompetitorRun, errorDetail } = require('../../../services/competitors/shopifyCompetitorRun');
const { MYTRUCKPOINT_PROFILE } = require('../../../lib/competitors/mytruckpoint/profile');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'logs', 'mytruckpoint');
const { runSeed: runSeedMytruckpoint, parseArgs, lastFullRunRows, EXIT_PARTIAL } = createCompetitorRun(MYTRUCKPOINT_PROFILE);

function buildDeps(argv) {
	const { buildCompetitorDeps } = require('../../../services/competitors/shopifyCompetitorDeps');
	const { getMytruckpointConfig, getMytruckpointOfflineConfig, DEFAULTS } = require('../../../config/mytruckpoint');
	return buildCompetitorDeps({
		profile: MYTRUCKPOINT_PROFILE, argv, getConfig: getMytruckpointConfig, getOfflineConfig: getMytruckpointOfflineConfig, defaults: DEFAULTS,
		snapshotDir: SNAPSHOT_DIR, vendorsPrefix: require('../hard-code_data/vendors_prefix'),
	});
}

async function main() {
	let deps = null;
	try {
		deps = buildDeps(process.argv.slice(2));
		const result = await runSeedMytruckpoint(deps);
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(`[mytruckpoint] fatal: ${errorDetail(error)}`);
		process.exitCode = 1;
	} finally {
		if (deps) await deps.disconnect();
	}
}

if (require.main === module) main();
module.exports = { runSeedMytruckpoint, parseArgs, lastFullRunRows, EXIT_PARTIAL, buildDeps };
