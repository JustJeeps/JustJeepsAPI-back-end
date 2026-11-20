// Niagara Jeeps competitor prices (DD-021). Thin entry: the run itself is the
// shared Shopify competitor run (services/competitors/shopifyCompetitorRun.js,
// DD-022) bound to the Niagara profile.
//
//   npm run seed-niagara                                  # collect + write
//   npm run seed-niagara -- --dry-run                     # collect + match report, no writes
//   npm run seed-niagara -- --collect-only                # collect + snapshot, never opens the database
//   npm run seed-niagara -- --brands=BIL,RC --max-pages=1 # sample run (skips the size floors)
//   npm run seed-niagara -- --from-snapshot <file>        # ingest a saved snapshot, no network
//
// Exit codes: 0 success, 1 failed (nothing written, except NIAGARA_WRITE_FAILED
// and NIAGARA_RUN_NOT_RECORDED, which say what was), 2 partial (written, the
// crawl stopped on its budget). Nothing is ever deleted: rows not seen are
// counted and reported.

const path = require('path');

const { createCompetitorRun, errorDetail } = require('../../../services/competitors/shopifyCompetitorRun');
const { NIAGARA_PROFILE } = require('../../../lib/competitors/niagara/profile');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'logs', 'niagara');
const { runSeed: runSeedNiagara, parseArgs, lastFullRunRows, EXIT_PARTIAL } = createCompetitorRun(NIAGARA_PROFILE);

function buildDeps(argv) {
	const { buildCompetitorDeps } = require('../../../services/competitors/shopifyCompetitorDeps');
	const { getNiagaraConfig, getNiagaraOfflineConfig, DEFAULTS } = require('../../../config/niagara');
	return buildCompetitorDeps({
		profile: NIAGARA_PROFILE, argv, getConfig: getNiagaraConfig, getOfflineConfig: getNiagaraOfflineConfig, defaults: DEFAULTS,
		snapshotDir: SNAPSHOT_DIR, vendorsPrefix: require('../hard-code_data/vendors_prefix'),
	});
}

async function main() {
	let deps = null;
	try {
		deps = buildDeps(process.argv.slice(2));
		const result = await runSeedNiagara(deps);
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(`[niagara] fatal: ${errorDetail(error)}`);
		process.exitCode = 1;
	} finally {
		if (deps) await deps.disconnect();
	}
}

if (require.main === module) main();
module.exports = { runSeedNiagara, parseArgs, lastFullRunRows, EXIT_PARTIAL };
