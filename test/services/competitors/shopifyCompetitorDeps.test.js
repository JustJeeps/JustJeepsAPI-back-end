const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const { buildCompetitorDeps } = require('../../../services/competitors/shopifyCompetitorDeps');
const { NIAGARA_PROFILE } = require('../../../lib/competitors/niagara/profile');
const { getNiagaraConfig, getNiagaraOfflineConfig, DEFAULTS } = require('../../../config/niagara');

const DEPS_KEYS = [
	'archive', 'argv', 'baseUrl', 'brands', 'buildReportCsv', 'collect', 'disconnect', 'env', 'filterBrands', 'getPrisma', 'ingest',
	'latestSnapshotName', 'leaseMinutes', 'lock', 'logger', 'now', 'readFile', 'snapshotDir', 'snapshotFileName', 'startRun', 'validateSnapshot', 'writeFile',
];
const vendorsPrefix = [{ jj_prefix: 'BIL', brand_name: 'Bilstein', niagara_code: 'bilstein', niagara_sku_prefixes: ['BIL-'] }];

function build(argv, env) {
	const saved = process.env.SCRAPER_CONTACT_EMAIL;
	process.env.SCRAPER_CONTACT_EMAIL = env.SCRAPER_CONTACT_EMAIL || '';
	try {
		return buildCompetitorDeps({ profile: NIAGARA_PROFILE, argv, getConfig: getNiagaraConfig, getOfflineConfig: getNiagaraOfflineConfig, defaults: DEFAULTS, snapshotDir: '/snap', vendorsPrefix });
	} finally {
		if (saved === undefined) delete process.env.SCRAPER_CONTACT_EMAIL;
		else process.env.SCRAPER_CONTACT_EMAIL = saved;
	}
}

test('the production deps of a store run have every key the runner reads, without loading prisma', () => {
	const original = Module._load;
	let prismaLoads = 0;
	Module._load = function load(request, ...rest) {
		if (/lib\/prisma$/.test(request)) prismaLoads += 1;
		return original.call(this, request, ...rest);
	};
	try {
		const deps = build(['--collect-only'], { SCRAPER_CONTACT_EMAIL: 'ops@example.com' });
		assert.deepStrictEqual(Object.keys(deps).sort(), DEPS_KEYS);
		assert.strictEqual(deps.leaseMinutes, DEFAULTS.maxRunMinutes + 30);
		assert.strictEqual(deps.baseUrl, 'https://niagarajeeps.ca');
		assert.deepStrictEqual(deps.brands, [{ jjPrefix: 'BIL', brandName: 'Bilstein', handle: 'bilstein', skuPrefixes: ['BIL-'] }]);
		assert.strictEqual(deps.snapshotFileName({ runId: 3, stamp: 's' }), 'niagara-run-3-s.json');
		assert.strictEqual(deps.latestSnapshotName, 'latest-snapshot.json');
		assert.strictEqual(prismaLoads, 0);
	} finally {
		Module._load = original;
	}
});

test('a snapshot replay builds its deps without the contact e-mail', () => {
	assert.throws(() => build([], {}), /SCRAPER_CONTACT_EMAIL is required/);
	assert.doesNotThrow(() => build(['--from-snapshot', 'x.json'], {}));
});
