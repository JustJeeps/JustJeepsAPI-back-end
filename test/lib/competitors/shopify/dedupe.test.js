const test = require('node:test');
const assert = require('node:assert');

const { dedupeItems } = require('../../../../lib/competitors/shopify/normalize');

const item = (sku, price, available, productId) => ({ jjPrefix: 'AFE', competitorSku: sku, price, available, productId });

test('by default the cheaper copy of a twin listing wins, as Niagara always did', () => {
	const { items, duplicates } = dedupeItems([item('BKJC_1', 90, true, 1), item('BKJC_1', 80, false, 2)]);
	assert.deepStrictEqual(items.map((i) => i.productId), [2]);
	assert.deepStrictEqual(duplicates.map((i) => i.productId), [1]);
});

test('preferAvailable keeps the purchasable copy first, then the cheaper one', () => {
	const options = { preferAvailable: true };
	assert.deepStrictEqual(dedupeItems([item('BKJC_1', 90, true, 1), item('BKJC_1', 80, false, 2)], options).items.map((i) => i.productId), [1]);
	assert.deepStrictEqual(dedupeItems([item('BKJC_1', 80, false, 1), item('BKJC_1', 90, true, 2)], options).items.map((i) => i.productId), [2]);
	assert.deepStrictEqual(dedupeItems([item('BKJC_1', 90, true, 1), item('BKJC_1', 85, true, 2)], options).items.map((i) => i.productId), [2]);
	assert.deepStrictEqual(dedupeItems([item('BKJC_1', 90, false, 1), item('BKJC_1', 85, false, 2)], options).items.map((i) => i.productId), [2]);
});

test('an equal twin keeps the first copy seen, so the pick is stable', () => {
	const { items } = dedupeItems([item('BKJC_1', 90, true, 1), item('BKJC_1', 90, true, 2)], { preferAvailable: true });
	assert.deepStrictEqual(items.map((i) => i.productId), [1]);
});
