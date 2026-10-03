const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tdotApi = require('../../../../prisma/seeds/api-calls/tdot-api');
const { createTdotSource } = tdotApi;
const { withConcurrency } = require('../../../../lib/ingest/withRetry');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/storefront-snippet.html'), 'utf8');
const klevuConfig = require('./fixtures/klevu-config.json');
const page0 = require('./fixtures/klevu-bestop-page0.json');
const silent = { info() {}, warn() {}, error() {} };
const env = { SCRAPER_CONTACT_EMAIL: 'dev@example.com', TDOT_PAGE_SIZE: '100', TDOT_REQUEST_DELAY_MS: '0', TDOT_MIN_MATCHED: '1', TDOT_MAX_FAILED_REQUEST_RATIO: '0.5', TDOT_MAX_INVALID_RATIO: '0.5' };

function makePrisma(products) {
	const calls = [];
	return { calls, product: { findMany: async (args) => { calls.push(args); return products; } } };
}

const fetchKlevu = async (url) => {
	if (url === 'https://www.tdotperformance.ca/') return { ok: true, status: 200, text: async () => html };
	if (url.endsWith('klevu-16884958633259895.json')) return { ok: true, status: 200, json: async () => klevuConfig };
	return { ok: true, status: 200, json: async () => ({ ...page0, meta: { ...page0.meta, totalResultsFound: 5 } }) };
};

test('the facade loads our targets, collects through Klevu, writes a snapshot and returns the legacy rows', async () => {
	const prisma = makePrisma([
		{ sku: 'BST-52401-11', searchable_sku: '52401-11', tdot_code: 'Bestop 52401-11', status: 1 },
		{ sku: 'BST-42811-01', searchable_sku: '42811-01', tdot_code: 'Bestop 42811-01', status: 1 },
	]);
	const written = [];
	const source = createTdotSource({
		prisma, env, fetch: fetchKlevu, logger: silent, sleep: async () => {}, now: () => new Date('2026-10-02T06:43:00.000Z'),
		withRetry: async (fn) => fn(), withConcurrency, labels: ['Bestop'], writeSnapshot: (payload, { dryRun, runId }) => { written.push(payload); assert.strictEqual(runId, 3); assert.strictEqual(dryRun, false); return '/tmp/snap.json'; },
	});
	const result = await source.fetchRows({ runId: 3 });
	assert.strictEqual(written[0].runId, 3);
	assert.deepStrictEqual(result.rows, [
		{ tdot_price: 273.98, tdot_code: 'Bestop 42811-01', sku: '42811-01', brand: 'Bestop', product_url: page0.result[0].url },
		{ tdot_price: 343.98, tdot_code: 'Bestop 52401-11', sku: '52401-11', brand: 'Bestop', product_url: page0.result[4].url },
	]);
	assert.strictEqual(result.payload.source, 'tdot');
	assert.strictEqual(result.payload.runId, 3);
	assert.strictEqual(result.snapshotPath, '/tmp/snap.json');
	assert.strictEqual(written.length, 1);
	assert.deepStrictEqual(prisma.calls[0].where, { AND: [{ tdot_code: { not: null } }, { tdot_code: { not: '' } }] });
	assert.deepStrictEqual(prisma.calls[0].select, { sku: true, searchable_sku: true, tdot_code: true, status: true });
});

test('the facade can read a snapshot file instead of hitting Klevu', async () => {
	const prisma = makePrisma([]);
	const payload = { schemaVersion: 1, source: 'tdot', items: [{ tdotCode: 'Bestop 1', productSku: 'BST-1', partNumber: '1', effectivePrice: 9, url: null }] };
	const source = createTdotSource({ prisma, env, fetch: async () => { throw new Error('no network expected'); }, logger: silent, labels: [], readSnapshot: () => payload });
	const result = await source.fetchRows({ fromSnapshot: '/tmp/x.json' });
	assert.deepStrictEqual(result.rows, [{ tdot_price: 9, tdot_code: 'Bestop 1', sku: '1', brand: 'Bestop', product_url: null }]);
	assert.strictEqual(prisma.calls.length, 0);
});

test('a snapshot file is validated and its own canaries are re-run before it is trusted', async () => {
	const prisma = makePrisma([]);
	const bad = { schemaVersion: 2, source: 'tdot', items: [] };
	let source = createTdotSource({ prisma, env, fetch: async () => { throw new Error('no network'); }, logger: silent, labels: [], readSnapshot: () => bad });
	await assert.rejects(source.fetchRows({ fromSnapshot: '/tmp/x.json' }), /schemaVersion/);
	const thin = { schemaVersion: 1, source: 'tdot', items: [], collection: { requests: 100, failedRequests: 90, rawCount: 10, invalidCount: 0 } };
	source = createTdotSource({ prisma, env: { ...env, TDOT_MIN_MATCHED: '1' }, fetch: async () => { throw new Error('no network'); }, logger: silent, labels: [], readSnapshot: () => thin });
	await assert.rejects(source.fetchRows({ fromSnapshot: '/tmp/x.json' }), (e) => e.code === 'TDOT_CANARY_FAILED');
});

test('the default snapshot writer names the file per run and only refreshes "latest" for real runs', () => {
	const { snapshotFileName } = require('../../../../prisma/seeds/api-calls/tdot-api');
	assert.strictEqual(snapshotFileName({ runId: 1170, dryRun: true, capturedAt: '2026-10-02T16:43:16.703Z' }), 'tdot-run-1170-dry-run-2026-10-02T16-43-16.json');
	assert.strictEqual(snapshotFileName({ runId: 1171, dryRun: false, capturedAt: '2026-10-03T01:43:00.000Z' }), 'tdot-run-1171-2026-10-03T01-43-00.json');
	assert.strictEqual(snapshotFileName({ runId: null, dryRun: false, capturedAt: '2026-10-03T01:43:00.000Z' }), 'tdot-run-manual-2026-10-03T01-43-00.json');
});

test('ParseHub is gone: TDOT_SOURCE=parsehub is ignored and the run still goes to Klevu', async () => {
	const prisma = makePrisma([{ sku: 'BST-52401-11', searchable_sku: '52401-11', tdot_code: 'Bestop 52401-11', status: 1 }]);
	const urls = [];
	const fetch = async (url, opts) => { urls.push(url); return fetchKlevu(url, opts); };
	const source = createTdotSource({
		prisma, env: { ...env, TDOT_SOURCE: 'parsehub', PARSEHUB_API_KEY: 'k' }, fetch, logger: silent, sleep: async () => {},
		withRetry: async (fn) => fn(), withConcurrency, labels: ['Bestop'], writeSnapshot: () => '/tmp/snap.json',
	});
	const result = await source.fetchRows({ runId: 1 });
	assert.strictEqual(result.payload.source, 'tdot');
	assert.ok(urls.every((u) => !/parsehub/i.test(u)), 'no ParseHub call');
	assert.strictEqual(source.describe(), 'klevu:tdotperformance.ca');
	assert.strictEqual(tdotApi.parseParsehubRows, undefined);
});

test('reading a snapshot does not require SCRAPER_CONTACT_EMAIL', async () => {
	const payload = { schemaVersion: 1, source: 'tdot', items: [{ tdotCode: 'Bestop 1', productSku: 'BST-1', partNumber: '1', effectivePrice: 9, url: null }], collection: { requests: 1, failedRequests: 0, matched: 1, rawCount: 1, invalidCount: 0 } };
	const fromFile = createTdotSource({ prisma: makePrisma([]), env: { TDOT_MIN_MATCHED: '1' }, fetch: async () => { throw new Error('no network'); }, logger: silent, labels: [], readSnapshot: () => payload });
	assert.strictEqual((await fromFile.fetchRows({ fromSnapshot: '/tmp/x.json' })).rows.length, 1);
});
