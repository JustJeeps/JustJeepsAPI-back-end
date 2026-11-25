// MyTruckPoint run end to end on fakes (DD-022): the real shared collector,
// snapshot, report, ingest and runner over a fake mytruckpoint.ca and a fake
// prisma. Checks what is MyTruckPoint's own: feed, lock and file names, codes,
// the competitor it writes to, and that it never reads or writes another
// competitor's rows.

const test = require('node:test');
const assert = require('node:assert');

// Safe to require: the CLI wiring only runs when the file is the entry point.
const { runSeedMytruckpoint } = require('../../prisma/seeds/seed-individual/seed-mytruckpoint');
const { MYTRUCKPOINT_PROFILE } = require('../../lib/competitors/mytruckpoint/profile');
const { getMytruckpointConfig } = require('../../config/mytruckpoint');
const { createBrandReader } = require('../../lib/competitors/shopify/brands');
const { createCollector } = require('../../lib/competitors/shopify/collect');
const { createSnapshot } = require('../../lib/competitors/shopify/snapshot');
const { buildReportCsv } = require('../../lib/competitors/shopify/report');
const { createShopifyIngest } = require('../../services/competitors/shopifyIngest');

const CLOCK = new Date('2026-11-19T22:17:00.000Z');
const env = { SCRAPER_CONTACT_EMAIL: 'ops@example.com', INGEST_TRIGGER: 'cron', MYTRUCKPOINT_MIN_ITEMS: '1', MYTRUCKPOINT_MIN_MATCHED: '1' };
const vendorsPrefix = [
	{ jj_prefix: 'WAR', brand_name: 'WARN', mytruckpoint_code: 'warn', mytruckpoint_sku_prefixes: ['BCSQ_'] },
	{ jj_prefix: 'BIL', brand_name: 'Bilstein', niagara_code: 'bilstein', niagara_sku_prefixes: ['BIL-'] },
];
const products = [{ sku: 'WAR-100970', searchable_sku: '100970', status: 1, jj_prefix: 'WAR' }, { sku: 'WAR-101255', searchable_sku: '101255', status: 1, jj_prefix: 'WAR' }];
const listing = (id, sku, vendor, price, available = true) => ({ id, handle: `warn-${id}`, vendor, variants: [{ id: id * 10, sku, price, available }] });
const ROUTES = {
	'/collections.json?page=1': { collections: [{ handle: 'warn', products_count: 4 }] },
	'/collections/warn/products.json?page=1': { products: [
		listing(1, 'BCSQ_100970', 'WARN IND.', '899.99'), listing(2, 'BCSQ_100970', 'Warn', '849.99', false),
		listing(3, 'BCSQ_101255', 'Warn', '120.00'), listing(4, 'BCSQ_999', 'Warn', '10.00'),
	] },
};

function setup({ argv = [], competitor = { id: 12, name: 'MyTruckPoint' } } = {}) {
	const out = { logs: [], files: {}, sql: [], findFirst: [], created: [], startRun: [], lock: [], urls: [] };
	const logger = { info: (m) => out.logs.push(m), warn: (m) => out.logs.push(m), error: (m) => out.logs.push(m) };
	const config = getMytruckpointConfig(env);
	const { readBrands, filterBrands } = createBrandReader(MYTRUCKPOINT_PROFILE);
	const brands = readBrands(vendorsPrefix);
	const { snapshotFileName, validateSnapshot, latestSnapshotName } = createSnapshot(MYTRUCKPOINT_PROFILE);
	const fetch = async (url) => {
		out.urls.push(url);
		const { pathname, searchParams } = new URL(url);
		const body = ROUTES[`${pathname}?page=${searchParams.get('page')}`] || { products: [] };
		return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) };
	};
	let opened = 0;
	const prisma = {
		ingestRun: { findFirst: async () => null },
		product: { findMany: async (q) => products.filter((p) => q.where.jj_prefix.in.includes(p.jj_prefix)) },
		competitor: {
			findFirst: async (q) => { out.findFirst.push(q); return competitor; },
			create: async (q) => { out.created.push(q.data); return { id: 13, ...q.data }; },
		},
		$queryRawUnsafe: async (sql, ...params) => { out.sql.push({ sql, params }); return [{ stale: 0 }]; },
		$executeRawUnsafe: (sql, ...params) => { out.sql.push({ sql, params }); return 1; },
		$transaction: async (list) => list,
	};
	const deps = {
		argv, env, logger, now: () => CLOCK, baseUrl: config.baseUrl, brands, filterBrands, snapshotFileName, buildReportCsv, snapshotDir: '/snap', latestSnapshotName,
		validateSnapshot: (p) => validateSnapshot(p, { now: () => CLOCK, maxAgeHours: 72, maxPrice: config.maxPrice, thresholds: config.thresholds }),
		readFile: (f) => out.files[f], writeFile: (f, body) => { out.files[f] = body; },
		collect: ({ brands: selected, runId, sample }) => createCollector(MYTRUCKPOINT_PROFILE)({ fetch, config, brands: selected, runId, logger, sample, sleep: async () => {}, random: () => 0, now: () => CLOCK }),
		getPrisma: () => { opened += 1; return prisma; },
		startRun: async (feed, opts) => { out.startRun.push([feed, opts]); return { id: 77, finish: async () => {} }; },
		ingest: (input) => createShopifyIngest(MYTRUCKPOINT_PROFILE)({ ...input, brands, thresholds: config.thresholds, logger }),
		archive: async (input) => ({ archived: false, reason: 'test', input }),
		leaseMinutes: 150,
		lock: { acquire: async (feed) => { out.lock.push(feed); return true; }, release: async (feed) => { out.lock.push(`release ${feed}`); } },
	};
	return { deps, out, opened: () => opened, brands };
}

test('only rows mapped with mytruckpoint_code are MyTruckPoint brands', () => {
	const { brands } = setup();
	assert.deepStrictEqual(brands, [{ jjPrefix: 'WAR', brandName: 'WARN', handle: 'warn', skuPrefixes: ['BCSQ_'] }]);
});

test('a full run writes the purchasable twin under the MyTruckPoint competitor, scoped by its id', async () => {
	const { deps, out } = setup();
	const result = await runSeedMytruckpoint(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(out.startRun[0], ['mytruckpoint', { sourceKind: 'api', sourceRef: 'https://www.mytruckpoint.ca', startedBy: 'cron' }]);
	assert.deepStrictEqual(out.lock, ['mytruckpoint', 'release mytruckpoint']);
	assert.deepStrictEqual(out.findFirst[0], { where: { name: { equals: 'MyTruckPoint', mode: 'insensitive' } } });
	assert.ok(out.sql.length >= 3);
	assert.ok(out.sql.every((q) => q.params[0] === 12), 'every query is scoped by the MyTruckPoint competitor id');
	assert.ok(out.sql.every((q) => !/DELETE/i.test(q.sql)), 'never a DELETE');
	const written = JSON.parse(out.sql.find((q) => q.sql.includes('UPDATE')).params[1]);
	assert.deepStrictEqual(written, [
		{ product_sku: 'WAR-100970', competitor_sku: 'BCSQ_100970', competitor_price: 899.99, product_url: 'https://www.mytruckpoint.ca/products/warn-1' },
		{ product_sku: 'WAR-101255', competitor_sku: 'BCSQ_101255', competitor_price: 120, product_url: 'https://www.mytruckpoint.ca/products/warn-3' },
	]);
	assert.ok(out.files['/snap/mytruckpoint-run-77-2026-11-19T22-17-00-000Z.json.gz']);
	assert.ok(out.files['/snap/latest-snapshot.json.gz']);
	assert.ok(out.files['/snap/mytruckpoint-run-77-report-2026-11-19T22-17-00-000Z.csv'].includes('BCSQ_999'));
	assert.ok(out.logs.some((l) => /^\[mytruckpoint\] brand WAR \(warn\): ok .*uncoded=0$/.test(l)));
	assert.ok(out.urls.every((u) => u.startsWith('https://www.mytruckpoint.ca/') && !u.includes('sort_by')));
});

test('the first real run creates the MyTruckPoint competitor only after the guards', async () => {
	const { deps, out } = setup({ competitor: null });
	const result = await runSeedMytruckpoint(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(out.created, [{ name: 'MyTruckPoint', website: 'https://www.mytruckpoint.ca/' }]);
	assert.ok(out.sql.filter((q) => !q.sql.includes('stale')).every((q) => q.params[0] === 13));
});

test('a dry run on a missing competitor writes nothing and creates nothing', async () => {
	const { deps, out } = setup({ argv: ['--dry-run'], competitor: null });
	const result = await runSeedMytruckpoint(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(out.created, []);
	assert.deepStrictEqual(out.sql, []);
});

test('--collect-only never opens the database', async () => {
	const { deps, out, opened } = setup({ argv: ['--collect-only'] });
	const result = await runSeedMytruckpoint(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.strictEqual(opened(), 0);
	assert.deepStrictEqual(out.startRun, []);
	assert.ok(out.files['/snap/mytruckpoint-collect-2026-11-19T22-17-00-000Z.json.gz']);
});

test('a busy lock answers with the MyTruckPoint code', async () => {
	const { deps } = setup();
	const result = await runSeedMytruckpoint({ ...deps, lock: { acquire: async () => false, release: async () => {} } });
	assert.strictEqual(result.exitCode, 1);
	assert.match(result.error, /^MYTRUCKPOINT_BUSY: another MyTruckPoint run holds the lock/);
});
