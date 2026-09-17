const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./fixtures/products-page.json');

const { normalizeItems, dedupeItems, buildPayload } = require('../../../lib/competitors/lowriders/normalize');

// The request from sales was explicit: when Lowriders shows a discount, we
// store the discounted price. The API carries it as `sale` (0 = no discount).
test('effective price is the sale price when present, else the regular price', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const sale = items.find((i) => i.competitorSku === '63470');
	const regular = items.find((i) => i.competitorSku === '699');
	assert.strictEqual(sale.regularPrice, 939.95);
	assert.strictEqual(sale.salePrice, 846.65);
	assert.strictEqual(sale.effectivePrice, 846.65);
	assert.strictEqual(regular.salePrice, null);
	assert.strictEqual(regular.effectivePrice, 112.95);
	assert.strictEqual(regular.currency, 'CAD');
});

// dealerid is lossy ("330.2"); stockid keeps the real part number.
test('part number comes from stockid minus the RCS- prefix, keeping dots', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const lossy = items.find((i) => i.stockId === 'RCS-330.20');
	assert.strictEqual(lossy.competitorSku, '330.20');
	assert.strictEqual(lossy.partNumber, '330.20');
	assert.strictEqual(lossy.url, 'https://lowriders.ca/i-23910053?');
	assert.strictEqual(lossy.availability, 'Inventory');
});

test('falls back to the title prefix, then dealerid, when stockid is missing', () => {
	const { items } = normalizeItems(
		[
			{ id: 1, title: '12345 | Something', price: 10, sale: 0, brand_name: 'Rough Country' },
			{ id: 2, dealerid: '777', price: 10, sale: 0, brand_name: 'Rough Country' },
		],
		{ maxPrice: 20000 },
	);
	assert.deepStrictEqual(items.map((i) => i.competitorSku), ['12345', '777']);
});

test('items with no usable price or part number are counted as invalid, not thrown', () => {
	const { items, invalidCount, invalidSample } = normalizeItems(
		[...fixture.list, { id: 9, stockid: 'RCS-1', price: 50000, sale: 0, brand_name: 'Rough Country' }, { id: 10, price: 5 }],
		{ maxPrice: 20000 },
	);
	assert.strictEqual(items.length, 4);
	assert.strictEqual(invalidCount, 3);
	assert.deepStrictEqual(invalidSample.map((s) => s.reason).sort(), ['invalid-price', 'invalid-price', 'no-part-number']);
});

test('dedupe keeps the lowest effective price per competitorSku and counts the rest', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const dup = { ...items[0], sourceId: 1, effectivePrice: 800, salePrice: 800 };
	const result = dedupeItems([...items, dup]);
	assert.strictEqual(result.items.length, 4);
	assert.strictEqual(result.duplicateCount, 1);
	assert.strictEqual(result.items.find((i) => i.competitorSku === '63470').effectivePrice, 800);
});

test('payload carries schemaVersion 1, the competitor, the brand and the collection stats', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const payload = buildPayload({
		items, runId: 42, capturedAt: '2026-09-18T07:13:00.000Z', reportedTotal: 7747,
		pagesFetched: 16, pageSize: 500, configSource: 'page', invalidCount: 1, duplicateCount: 0, brandId: 90296,
	});
	assert.strictEqual(payload.schemaVersion, 1);
	assert.strictEqual(payload.source, 'lowriders');
	assert.deepStrictEqual(payload.competitor, { name: 'Lowriders', website: 'https://www.lowriders.ca/' });
	assert.deepStrictEqual(payload.brand, { name: 'Rough Country', sourceBrandId: 90296 });
	assert.strictEqual(payload.runId, 42);
	assert.strictEqual(payload.collection.reportedTotal, 7747);
	assert.strictEqual(payload.collection.invalidCount, 1);
	assert.strictEqual(payload.items.length, 4);
});
