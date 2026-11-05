const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { collectNiagara } = require('../../../../lib/competitors/niagara/collect');

const challengeHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'cf-challenge.html'), 'utf8');
const quiet = { info() {}, warn() {}, error() {} };
const thresholds = { minItems: 1, minMatched: 1, maxFailedRequestRatio: 0.5, maxBrandsFailedRatio: 0.5, maxInvalidRatio: 0.5, matchDropRatio: 0.8 };
const config = {
	baseUrl: 'https://niagarajeeps.ca', userAgent: 'ua', timeoutMs: 1000, pageSize: 2, maxPrice: 20000,
	requestDelayMs: 0, jitterMs: 0, maxAttempts: 1, backoffMs: 0, retryAfterCapMs: 0, challengeRetryDelayMs: 0,
	consecutiveFailureLimit: 5, maxRequests: 100, maxRunMinutes: 60, maxPagesPerBrand: 10, thresholds,
};

const product = (id, sku, { vendor = 'BILSTEIN', price = '10.00' } = {}) => ({ id, handle: `h-${id}`, vendor, variants: [{ id: id * 10, sku, price, available: true }] });
const json = (body) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) });
const status = (code, body = '', contentType = 'text/plain') => ({ ok: false, status: code, headers: new Headers({ 'content-type': contentType }), text: async () => body });

function site(routes) {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		const { pathname, searchParams } = new URL(url);
		const route = routes[`${pathname}?page=${searchParams.get('page')}`] ?? routes[pathname];
		if (typeof route === 'function') return route();
		if (route === undefined) return json({ products: [] });
		return json(route);
	};
	return { fetch, calls };
}

const brands = [{ jjPrefix: 'BIL', handle: 'bilstein', skuPrefixes: ['BIL-'] }, { jjPrefix: 'RR', handle: 'rugged-ridge', skuPrefixes: [] }];
const index = { collections: [{ handle: 'bilstein', products_count: 3 }, { handle: 'rugged-ridge', products_count: 0 }] };
const run = (fetch, extra = {}) => collectNiagara({ fetch, config: { ...config, ...(extra.config || {}) }, brands: extra.brands || brands, logger: quiet, sleep: async () => {}, random: () => 0, sample: extra.sample || null });

test('a full run pages each brand until a short page and tags items with the brand', async () => {
	const { fetch, calls } = site({
		'/collections.json': index,
		'/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-24-1'), product(2, '24-2')] },
		'/collections/bilstein/products.json?page=2': { products: [product(3, 'BIL-24-3')] },
	});
	const { payload } = await run(fetch);
	assert.deepStrictEqual(payload.items.map((i) => [i.jjPrefix, i.competitorSku]), [['BIL', 'BIL-24-1'], ['BIL', '24-2'], ['BIL', 'BIL-24-3']]);
	assert.deepStrictEqual(payload.brandStats.map((b) => [b.jjPrefix, b.status, b.pages, b.products]), [['BIL', 'ok', 2, 3], ['RR', 'empty', 1, 0]]);
	assert.strictEqual(payload.schemaVersion, 1);
	assert.strictEqual(payload.source, 'niagara');
	assert.strictEqual(payload.collection.brandsOk, 1);
	assert.strictEqual(payload.collection.brandsEmpty, 1);
	assert.ok(calls.every((url) => !url.includes('/products.json?') || url.includes('/collections/')), 'never the capped whole-store endpoint');
});

test('a product repeated across pages is counted once', async () => {
	const { fetch } = site({
		'/collections.json': index,
		'/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-24-1'), product(2, '24-2')] },
		'/collections/bilstein/products.json?page=2': { products: [product(2, '24-2')] },
	});
	const { payload } = await run(fetch, { brands: [brands[0]] });
	assert.strictEqual(payload.brandStats[0].products, 2);
	assert.strictEqual(payload.items.length, 2);
});

test('a handle missing from the collections index is reported, not crawled', async () => {
	const { fetch, calls } = site({ '/collections.json': { collections: [{ handle: 'bilstein', products_count: 1 }] }, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1')] } });
	const { payload } = await run(fetch);
	assert.strictEqual(payload.brandStats[1].status, 'missing-handle');
	assert.ok(!calls.some((u) => u.includes('rugged-ridge')));
	assert.strictEqual(payload.collection.brandsFailed, 1);
});

test('another vendor in a collection is dropped; past 25% the whole brand is dropped as impure and counts as failed', async () => {
	// dana-spicer on 2026-11-05: 1 of 8 products is Niagara's own house brand.
	const houseBrand = [...Array.from({ length: 7 }, (_, i) => product(i + 1, `BIL-${i}`)), product(99, 'NJ-1', { vendor: 'NIAGARA JEEPS & TRUCKS' })];
	const one = site({ '/collections.json': index, '/collections/bilstein/products.json?page=1': { products: houseBrand } });
	const kept = await run(one.fetch, { brands: [brands[0]], config: { pageSize: 250 } });
	assert.strictEqual(kept.payload.brandStats[0].status, 'ok');
	assert.strictEqual(kept.payload.items.length, 7);
	assert.strictEqual(kept.payload.brandStats[0].foreign, 1);

	const many = site({ '/collections.json': index, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1'), product(2, 'FOX-2', { vendor: 'FOX' }), product(3, 'BIL-3')] } });
	const dropped = await run(many.fetch, { brands: [brands[0]], config: { pageSize: 250, thresholds: { ...thresholds, minItems: 0, maxBrandsFailedRatio: 1 } } });
	assert.strictEqual(dropped.payload.brandStats[0].status, 'impure');
	assert.strictEqual(dropped.payload.items.length, 0);
	assert.strictEqual(dropped.payload.collection.brandsFailed, 1);
});

test('a brand that fills every page up to the cap is flagged page-cap, not ok', async () => {
	const full = site({ '/collections.json': index, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1'), product(2, 'BIL-2')] }, '/collections/bilstein/products.json?page=2': { products: [product(3, 'BIL-3'), product(4, 'BIL-4')] } });
	const capped = await run(full.fetch, { brands: [brands[0]], config: { maxPagesPerBrand: 2 } });
	assert.strictEqual(capped.payload.brandStats[0].status, 'page-cap');
	assert.strictEqual(capped.payload.items.length, 4);
	const sampled = await run(full.fetch, { brands: [brands[0]], sample: { brands: ['BIL'], maxPages: 1 } });
	assert.strictEqual(sampled.payload.brandStats[0].status, 'ok', 'a sample stops early on purpose');
});

test('a collections index that fills every page is treated as incomplete, so no brand is called missing', async () => {
	const page = { collections: Array.from({ length: 250 }, (_, i) => ({ handle: `other-${i}`, products_count: 1 })) };
	const { fetch } = site({ '/collections.json': page, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1')] } });
	const { payload } = await run(fetch, { brands: [brands[0]] });
	assert.strictEqual(payload.brandStats[0].status, 'ok');
	assert.strictEqual(payload.collection.brandsFailed, 0);
});

test('a Cloudflare challenge stops the run loudly', async () => {
	const { fetch } = site({ '/collections.json': index, '/collections/bilstein/products.json?page=1': () => status(403, challengeHtml, 'text/html') });
	await assert.rejects(run(fetch), (err) => err.code === 'NIAGARA_CHALLENGED');
});

test('consecutive failures trip the circuit breaker', async () => {
	const { fetch } = site({ '/collections.json': () => status(502) });
	await assert.rejects(run(fetch, { config: { consecutiveFailureLimit: 1 } }), (err) => err.code === 'NIAGARA_SOURCE_UNAVAILABLE');
});

test('a failed page in the middle of a brand drops the brand instead of writing part of it', async () => {
	const { fetch } = site({
		'/collections.json': index,
		'/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1'), product(2, 'BIL-2')] },
		'/collections/bilstein/products.json?page=2': () => status(500),
	});
	const { payload } = await run(fetch, { brands: [brands[0]], config: { thresholds: { ...thresholds, minItems: 0, maxBrandsFailedRatio: 1 } } });
	assert.strictEqual(payload.brandStats[0].status, 'failed');
	assert.strictEqual(payload.items.length, 0);
	assert.strictEqual(payload.collection.failedRequests, 1);
});

test('the request budget marks the run partial and the remaining brands over-budget', async () => {
	const { fetch } = site({ '/collections.json': { collections: [{ handle: 'bilstein', products_count: 1 }, { handle: 'rugged-ridge', products_count: 0 }] }, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1')] } });
	const { payload } = await run(fetch, { config: { maxRequests: 2, thresholds: { ...thresholds, maxBrandsFailedRatio: 1 } } });
	assert.strictEqual(payload.collection.partial, true);
	assert.deepStrictEqual(payload.brandStats.map((b) => b.status), ['ok', 'over-budget']);
});

test('a failing canary aborts with the reasons', async () => {
	const { fetch } = site({ '/collections.json': index, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1', { price: '0' })] } });
	await assert.rejects(run(fetch, { brands: [brands[0]] }), (err) => err.code === 'NIAGARA_CANARY_FAILED' && err.failures.some((f) => f.code === 'PRICE_INVALID_RATIO'));
});

test('a sample run stops after maxPages and skips the short-brand check', async () => {
	const { fetch, calls } = site({
		'/collections.json': { collections: [{ handle: 'bilstein', products_count: 500 }] },
		'/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1'), product(2, 'BIL-2')] },
	});
	const { payload } = await run(fetch, { brands: [brands[0]], sample: { brands: ['BIL'], maxPages: 1 } });
	assert.strictEqual(calls.filter((u) => u.includes('/collections/bilstein/')).length, 1);
	assert.strictEqual(payload.brandStats[0].status, 'ok');
	assert.deepStrictEqual(payload.sample, { brands: ['BIL'], maxPages: 1 });
});

test('a brand far below its products_count is marked short', async () => {
	const { fetch } = site({ '/collections.json': { collections: [{ handle: 'bilstein', products_count: 50 }] }, '/collections/bilstein/products.json?page=1': { products: [product(1, 'BIL-1')] } });
	const { payload } = await run(fetch, { brands: [brands[0]] });
	assert.strictEqual(payload.brandStats[0].status, 'short');
});
