const test = require('node:test');
const assert = require('node:assert');

const { defineStoreProfile } = require('../../../../lib/competitors/shopify/profile');
const { createSnapshot } = require('../../../../lib/competitors/shopify/snapshot');
const { createBrandReader } = require('../../../../lib/competitors/shopify/brands');
const niagaraSnapshot = require('../../../../lib/competitors/niagara/snapshot');

const profile = defineStoreProfile({
	key: 'shopx', errorPrefix: 'SHOPX', shortName: 'Shop X', competitor: { name: 'Shop X', website: 'https://shopx.test/' },
	mapping: { handleField: 'shopx_code', prefixesField: 'shopx_sku_prefixes' },
});
const now = () => new Date('2026-11-19T12:00:00Z');
const thresholds = { minItems: 0, maxFailedRequestRatio: 1, maxBrandsFailedRatio: 1, maxInvalidRatio: 1 };
const options = { now, maxAgeHours: 72, maxPrice: 20000, thresholds };
const payload = (source) => ({
	schemaVersion: 1, source, capturedAt: '2026-11-19T10:00:00Z', sample: null,
	items: [{ jjPrefix: 'BIL', competitorSku: 'BBGL_24-1', price: 10, url: 'https://shopx.test/products/a' }],
	collection: { requests: 1, failedRequests: 0, brandsPlanned: 1, brandsFailed: 0, rawVariants: 1, invalidCount: 0, items: 1 },
});

test('snapshot names carry the store key', () => {
	const { snapshotFileName } = createSnapshot(profile);
	assert.strictEqual(snapshotFileName({ runId: null, stamp: 's' }), 'shopx-collect-s.json');
	assert.strictEqual(snapshotFileName({ runId: 9, dryRun: true, sample: true, stamp: 's' }), 'shopx-run-9-dry-run-sample-s.json');
});

test('a store refuses another store payload, both ways, with its own code', () => {
	const { validateSnapshot } = createSnapshot(profile);
	assert.ok(validateSnapshot(payload('shopx'), options));
	assert.throws(() => validateSnapshot(payload('niagara'), options), (e) => e.code === 'SHOPX_BAD_SNAPSHOT' && /not a Shop X payload/.test(e.message));
	assert.throws(() => niagaraSnapshot.validateSnapshot(payload('shopx'), options), (e) => e.code === 'NIAGARA_BAD_SNAPSHOT');
});

test('the brand reader reads the store fields and names the store on a typo', () => {
	const { readBrands, filterBrands } = createBrandReader(profile);
	const brands = readBrands([
		{ jj_prefix: 'BIL', brand_name: 'Bilstein', shopx_code: ' Bilstein ', shopx_sku_prefixes: ['bbgl_'], niagara_code: 'ignored' },
		{ jj_prefix: 'RR', brand_name: 'Rugged Ridge', niagara_code: 'rugged-ridge' },
	]);
	assert.deepStrictEqual(brands, [{ jjPrefix: 'BIL', brandName: 'Bilstein', handle: 'bilstein', skuPrefixes: ['BBGL_'] }]);
	assert.throws(() => filterBrands(brands, ['RR']), /not mapped to Shop X: RR/);
});
