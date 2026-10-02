const test = require('node:test');
const assert = require('node:assert');

const { normalizeRecord, normalizeRecords, dedupeItems, tdotCodeFromRecord } = require('../../../../lib/competitors/tdot/normalize');

const page0 = require('./fixtures/klevu-bestop-page0.json');
const page1 = require('./fixtures/klevu-bestop-page1.json');

test('tdotCodeFromRecord takes the name prefix before " - " and falls back to the sku', () => {
	assert.strictEqual(tdotCodeFromRecord({ name: 'Bestop 52401-11 - Sun Bikini Top', sku: 'Bestop-52401-11' }), 'Bestop 52401-11');
	assert.strictEqual(tdotCodeFromRecord({ name: 'Just a name without separator', sku: 'Bestop-52401-11' }), 'Bestop 52401-11', 'sku: first hyphen becomes a space');
	assert.strictEqual(tdotCodeFromRecord({ name: '', sku: 'RuggedRidge-11540.13' }), 'RuggedRidge 11540.13');
	assert.strictEqual(tdotCodeFromRecord({ name: '', sku: '' }), '');
});

test('normalizeRecord keeps the fields the pipeline needs and picks the selling price', () => {
	const { item, reason } = normalizeRecord(page0.result[4], { maxPrice: 20000 });
	assert.strictEqual(reason, null);
	assert.deepStrictEqual(item, {
		sourceId: '308509',
		competitorSku: 'Bestop 52401-11',
		skuToken: 'Bestop-52401-11',
		partNumber: '52401-11',
		title: 'Bestop 52401-11 - Sun Bikini Top - Safari Style - Mesh (4-Dr)',
		regularPrice: 343.98,
		salePrice: null,
		effectivePrice: 343.98,
		oldPrice: 343.98,
		discount: null,
		rawPrice: { price: '343.98', salePrice: '343.98', oldPrice: '343.98' },
		currency: 'CAD',
		url: 'https://www.tdotperformance.ca/products/bestop-52401-11-sun-bikini-top-safari-style-mesh-4-dr.html',
		inStock: true,
	});
});

test('normalizeRecord uses salePrice when it is lower than price', () => {
	const { item } = normalizeRecord(page1.result[3], { maxPrice: 20000 });
	assert.strictEqual(item.regularPrice, 200);
	assert.strictEqual(item.salePrice, 150);
	assert.strictEqual(item.effectivePrice, 150);
});

test('normalizeRecord rejects records without a usable price, with a part number or with another currency', () => {
	assert.strictEqual(normalizeRecord(page1.result[4], { maxPrice: 20000 }).reason, 'invalid-price');
	assert.strictEqual(normalizeRecord({ ...page0.result[0], price: '99999', salePrice: '99999' }, { maxPrice: 20000 }).reason, 'invalid-price');
	assert.strictEqual(normalizeRecord({ ...page0.result[0], currency: 'USD' }, { maxPrice: 20000 }).reason, 'currency-mismatch');
	assert.strictEqual(normalizeRecord({ ...page0.result[0], sku: '', name: '' }, { maxPrice: 20000 }).reason, 'no-part-number');
	assert.strictEqual(normalizeRecord(null, { maxPrice: 20000 }).reason, 'not-an-object');
});

test('normalizeRecords counts invalid records and keeps a sample with the reason', () => {
	const out = normalizeRecords([...page0.result, ...page1.result], { maxPrice: 20000 });
	assert.strictEqual(out.items.length, 9);
	assert.strictEqual(out.invalidCount, 1);
	assert.deepStrictEqual(out.invalidSample, [{ reason: 'invalid-price', sourceId: '999002', sku: 'Bestop-99999-02' }]);
});

test('dedupeItems keeps one item per canonical competitor sku, the cheapest', () => {
	const a = normalizeRecord(page0.result[0], { maxPrice: 20000 }).item;
	const b = { ...a, sourceId: 'dup', competitorSku: 'BESTOP 42811 01', effectivePrice: a.effectivePrice - 1 };
	const { items, duplicateCount } = dedupeItems([a, b]);
	assert.strictEqual(items.length, 1);
	assert.strictEqual(items[0].sourceId, 'dup');
	assert.strictEqual(duplicateCount, 1);
});

// Klevu answers category hits ("categoryid_505", no sku) among the products;
// they are not broken prices and must not feed the invalid-price canary.
test('normalizeRecords sets category records aside instead of counting them as invalid', () => {
	const out = normalizeRecords([{ id: 'categoryid_505', sku: '', name: 'Brakes', price: '' }, ...page0.result], { maxPrice: 20000 });
	assert.strictEqual(out.items.length, 5);
	assert.strictEqual(out.invalidCount, 0);
	assert.strictEqual(out.categoryCount, 1);
});
