// Golden run of the whole Niagara Jeeps pipeline (DD-021): the real collector,
// snapshot, report, ingest and runner, wired through their public exports over
// a fake site, clock, file system, prisma, lock and archive. Every observable
// output (log lines, files, IngestRun calls, SQL parameters, lock and archive
// calls, exit codes) is compared with a committed fixture, so a refactor of the
// shared Shopify code cannot change what Niagara does without failing here.
//
// Regenerate the fixture only on purpose: UPDATE_GOLDEN=1 node --test <this file>

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { runSeedNiagara } = require('../../prisma/seeds/seed-individual/seed-niagara');
const { getNiagaraConfig, getNiagaraOfflineConfig } = require('../../config/niagara');
const { niagaraBrands, filterBrands } = require('../../lib/competitors/niagara/brands');
const { collectNiagara } = require('../../lib/competitors/niagara/collect');
const { snapshotFileName, validateSnapshot } = require('../../lib/competitors/niagara/snapshot');
const { buildReportCsv } = require('../../lib/competitors/niagara/report');
const { ingestNiagara } = require('../../services/competitors/niagaraIngest');

const FIXTURE = path.join(__dirname, 'fixtures', 'niagara-golden.json');
const CLOCK = new Date('2026-11-19T23:00:00.000Z');
const challengeHtml = fs.readFileSync(path.join(__dirname, '..', 'lib', 'competitors', 'niagara', 'fixtures', 'cf-challenge.html'), 'utf8');

const VENDORS_PREFIX = [
	{ jj_prefix: 'BIL', brand_name: 'Bilstein', niagara_code: 'bilstein', niagara_sku_prefixes: ['BIL-'] },
	{ jj_prefix: 'RR', brand_name: 'Rugged Ridge', niagara_code: 'rugged-ridge' },
	{ jj_prefix: 'GOR', brand_name: 'Go Rhino', niagara_code: 'go-rhino', niagara_sku_prefixes: ['RHI-'] },
	{ jj_prefix: 'XXX', brand_name: 'Not on Niagara' },
];

const BASE_ENV = Object.freeze({
	SCRAPER_CONTACT_EMAIL: 'ops@example.com', INGEST_TRIGGER: 'cron',
	NIAGARA_PAGE_SIZE: '2', NIAGARA_MIN_ITEMS: '1', NIAGARA_MIN_MATCHED: '1', NIAGARA_MAX_BRANDS_FAILED_RATIO: '0.5', NIAGARA_MAX_INVALID_RATIO: '0.5',
});

const variant = (id, sku, price, extra = {}) => ({ id, sku, price, compare_at_price: null, available: true, ...extra });
const product = (id, vendor, variants) => ({ id, handle: `item-${id}`, vendor, variants });

const ROUTES = {
	'/collections.json?page=1': { collections: [
		{ handle: 'bilstein', products_count: 3 }, { handle: 'rugged-ridge', products_count: 2 }, { handle: 'go-rhino', products_count: 1 },
	] },
	'/collections/bilstein/products.json?page=1': { products: [
		product(1, 'Bilstein', [variant(11, 'bil-24-1', '10.00')]),
		product(2, 'BILSTEIN', [variant(21, '24-2', '20.50', { compare_at_price: '25.00', available: false })]),
	] },
	'/collections/bilstein/products.json?page=2': { products: [product(3, 'Bilstein', [variant(31, 'BIL-24-3', '30.00')])] },
	'/collections/rugged-ridge/products.json?page=1': { products: [
		product(4, 'Rugged Ridge', [variant(41, '11203.01', '40.00')]),
		product(5, 'Omix', [variant(51, '17212.06', '50.00')]),
	] },
	'/collections/go-rhino/products.json?page=1': { products: [
		product(6, 'Go Rhino', [variant(61, 'RHI-1', '60.00'), variant(62, 'RHI-2', '0'), variant(63, '', '9.00')]),
	] },
};

const PRODUCTS = [
	{ sku: 'BIL-24-1', searchable_sku: '24-1', status: 1, jj_prefix: 'BIL' },
	{ sku: 'BIL-24-2', searchable_sku: '24-2', status: 1, jj_prefix: 'BIL' },
	{ sku: 'BIL-24-9', searchable_sku: '24-9', status: 1, jj_prefix: 'BIL' },
	{ sku: 'GOR-1', searchable_sku: '1', status: 1, jj_prefix: 'GOR' },
];

const response = (status, body, contentType) => ({
	ok: status < 400, status, headers: new Headers({ 'content-type': contentType }), text: async () => body,
});

function fakeSite({ challengeOn = null } = {}) {
	const urls = [];
	const fetch = async (url, options) => {
		urls.push([url, options.headers]);
		const { pathname, searchParams } = new URL(url);
		const key = `${pathname}?page=${searchParams.get('page')}`;
		if (challengeOn && key === challengeOn) return response(403, challengeHtml, 'text/html');
		const body = ROUTES[key] || (pathname === '/collections.json' ? { collections: [] } : { products: [] });
		return response(200, JSON.stringify(body), 'application/json');
	};
	return { fetch, urls };
}

function fakePrisma(record, { lastRun = { sourceRowCount: 2 }, competitor = { id: 7, name: 'Niagara Jeeps' } } = {}) {
	return {
		ingestRun: { findFirst: async (q) => { record.push(['ingestRun.findFirst', q]); return lastRun; } },
		product: { findMany: async (q) => { record.push(['product.findMany', q]); return PRODUCTS; } },
		competitor: {
			findFirst: async (q) => { record.push(['competitor.findFirst', q]); return competitor; },
			create: async (q) => { record.push(['competitor.create', q]); return { id: 8, ...q.data }; },
		},
		$queryRawUnsafe: async (sql, ...params) => { record.push(['$queryRawUnsafe', sql.trim().split('\n')[0], params]); return [{ stale: 1 }]; },
		$executeRawUnsafe: (sql, ...params) => { record.push(['$executeRawUnsafe', sql.trim().split('\n')[1].trim(), params]); return 1; },
		$transaction: async (list) => list,
	};
}

// Mirrors buildDeps in seed-niagara.js, with every side effect captured.
function wire({ argv = [], env = {}, site = fakeSite(), prismaOptions, lockFree = true, files = {} }) {
	const out = { logs: [], files, prisma: [], startRun: [], finish: [], archive: [], lock: [] };
	const fullEnv = { ...BASE_ENV, ...env };
	const logger = { info: (m) => out.logs.push(['info', m]), warn: (m) => out.logs.push(['warn', m]), error: (m) => out.logs.push(['error', m]) };
	const offline = argv.some((a) => a.startsWith('--from-snapshot'));
	const config = offline ? getNiagaraOfflineConfig(fullEnv) : getNiagaraConfig(fullEnv);
	const brands = niagaraBrands(VENDORS_PREFIX);
	const prisma = fakePrisma(out.prisma, prismaOptions);
	const deps = {
		argv, env: fullEnv, logger, now: () => CLOCK, baseUrl: config.baseUrl || 'https://niagarajeeps.ca',
		brands, filterBrands, snapshotFileName, buildReportCsv, snapshotDir: '/snap',
		validateSnapshot: (payload) => validateSnapshot(payload, { now: () => CLOCK, maxAgeHours: config.snapshotMaxAgeHours, maxPrice: config.maxPrice, thresholds: config.thresholds }),
		readFile: (file) => files[file],
		writeFile: (file, body) => { files[file] = body; },
		collect: ({ brands: selected, runId, sample }) => collectNiagara({ fetch: site.fetch, config, brands: selected, runId, logger, sample, sleep: async () => {}, random: () => 0, now: () => CLOCK }),
		getPrisma: () => prisma,
		startRun: async (feed, opts) => {
			out.startRun.push([feed, opts]);
			return { id: 501, finish: async (o) => { out.finish.push(o); } };
		},
		ingest: (input) => ingestNiagara({ ...input, brands, thresholds: config.thresholds, logger }),
		archive: async (input) => { out.archive.push(input); return { archived: true, key: `k/${path.basename(input.filePath)}` }; },
		leaseMinutes: config.maxRunMinutes + 30,
		lock: {
			acquire: async (feed, opts) => { out.lock.push(['acquire', feed, opts]); return lockFree; },
			release: async (feed) => { out.lock.push(['release', feed]); },
		},
	};
	return { deps, out, site };
}

async function scenario(options) {
	const { deps, out, site } = wire(options);
	const result = await runSeedNiagara(deps);
	return { result, ...out, urls: site.urls };
}

async function replayScenario() {
	const full = await scenario({});
	const files = { '/snap/saved.json': full.files['/snap/latest-snapshot.json'] };
	return scenario({ argv: ['--from-snapshot', '/snap/saved.json'], files });
}

const SCENARIOS = {
	full: () => scenario({}),
	dryRun: () => scenario({ argv: ['--dry-run'], prismaOptions: { competitor: null } }),
	sample: () => scenario({ argv: ['--brands=BIL', '--max-pages=1'] }),
	collectOnly: () => scenario({ argv: ['--collect-only'] }),
	partial: () => scenario({ env: { NIAGARA_MAX_REQUESTS: '4', NIAGARA_MAX_BRANDS_FAILED_RATIO: '0.9' } }),
	challenged: () => scenario({ site: fakeSite({ challengeOn: '/collections/rugged-ridge/products.json?page=1' }) }),
	guardRefusal: () => scenario({ env: { NIAGARA_MIN_MATCHED: '50' } }),
	firstRealRun: () => scenario({ prismaOptions: { competitor: null, lastRun: null } }),
	replay: replayScenario,
	busyLock: () => scenario({ lockFree: false }),
};

async function runAll() {
	const results = {};
	for (const [name, fn] of Object.entries(SCENARIOS)) results[name] = JSON.parse(JSON.stringify(await fn()));
	return results;
}

test('the Niagara pipeline output matches the committed golden fixture in every scenario', async () => {
	const actual = await runAll();
	if (process.env.UPDATE_GOLDEN === '1') {
		fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
		fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
	}
	const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));
	for (const name of Object.keys(expected)) assert.deepStrictEqual(actual[name], expected[name], `scenario ${name} changed`);
});

test('the golden scenarios cover each exit path at least once', async () => {
	const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	const codes = new Set(Object.values(expected).map((s) => s.result.exitCode));
	assert.deepStrictEqual([...codes].sort(), [0, 1, 2]);
});
