const test = require('node:test');
const assert = require('node:assert');

const { defineStoreProfile } = require('../../../../lib/competitors/shopify/profile');
const { createCollector } = require('../../../../lib/competitors/shopify/collect');

const profile = defineStoreProfile({
	key: 'shopx', errorPrefix: 'SHOPX', shortName: 'Shop X', competitor: { name: 'Shop X', website: 'https://shopx.test/' },
	mapping: { handleField: 'shopx_code', prefixesField: 'shopx_sku_prefixes' }, purity: 'sku-code',
});
const thresholds = { minItems: 1, minMatched: 1, maxFailedRequestRatio: 0.5, maxBrandsFailedRatio: 0.5, maxInvalidRatio: 0.5, matchDropRatio: 0.8 };
const config = {
	baseUrl: 'https://shopx.test', userAgent: 'ua', timeoutMs: 1000, pageSize: 250, maxPrice: 20000,
	requestDelayMs: 0, jitterMs: 0, maxAttempts: 1, backoffMs: 0, retryAfterCapMs: 0, challengeRetryDelayMs: 0,
	consecutiveFailureLimit: 5, maxRequests: 100, maxRunMinutes: 60, maxPagesPerBrand: 10, thresholds,
};
const product = (id, sku, vendor, extra = {}) => ({ id, handle: `h-${id}`, vendor, variants: [{ id: id * 10, sku, price: '10.00', available: true, ...extra }] });
const json = (body) => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) });

function site(routes) {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		const { pathname, searchParams } = new URL(url);
		return json(routes[`${pathname}?page=${searchParams.get('page')}`] || (pathname === '/collections.json' ? { collections: [] } : { products: [] }));
	};
	return { fetch, calls };
}

const collect = createCollector(profile);
const quiet = { info() {}, warn() {}, error() {} };

test('a sku-code store keeps a brand whose vendor text varies and counts SKUs without a code', async () => {
	const lines = [];
	const { fetch } = site({
		'/collections.json?page=1': { collections: [{ handle: 'warn', products_count: 4 }] },
		'/collections/warn/products.json?page=1': { products: [
			product(1, 'BCSQ_100970', 'WARN IND.'), product(2, 'BCSQ_100969', 'Warn'), product(3, 'BCSQ_101255', 'Warn'), product(4, 'warn-9', 'Warn'),
		] },
	});
	const { payload } = await collect({ fetch, config, brands: [{ jjPrefix: 'WAR', handle: 'warn', skuPrefixes: ['BCSQ_'] }], logger: { ...quiet, info: (m) => lines.push(m) }, sleep: async () => {}, random: () => 0 });
	assert.deepStrictEqual(payload.items.map((i) => i.competitorSku), ['BCSQ_100970', 'BCSQ_100969', 'BCSQ_101255']);
	assert.strictEqual(payload.source, 'shopx');
	assert.strictEqual(payload.brandStats[0].uncoded, 1);
	assert.strictEqual(payload.collection.uncodedCount, 1);
	assert.match(lines.find((l) => l.includes('brand WAR')), /^\[shopx\] brand WAR \(warn\): ok .* foreign=0 uncoded=1$/);
});

test('a handle with an underscore is crawled as is and the store never sorts', async () => {
	const { fetch, calls } = site({
		'/collections.json?page=1': { collections: [{ handle: 'afe_power', products_count: 1 }] },
		'/collections/afe_power/products.json?page=1': { products: [product(1, 'BKJC_50-1', 'aFe')] },
	});
	const { payload } = await collect({ fetch, config, brands: [{ jjPrefix: 'AFE', handle: 'afe_power', skuPrefixes: ['BKJC_'] }], logger: quiet, sleep: async () => {}, random: () => 0 });
	assert.strictEqual(payload.items.length, 1);
	assert.ok(calls.some((u) => u.startsWith('https://shopx.test/collections/afe_power/products.json?limit=250&page=1')));
	assert.ok(calls.every((u) => !u.includes('sort_by') && !u.includes('+')));
});
