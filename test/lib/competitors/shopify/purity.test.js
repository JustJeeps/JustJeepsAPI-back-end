const test = require('node:test');
const assert = require('node:assert');

const { vendorPurity, purityRule } = require('../../../../lib/competitors/shopify/purity');

const item = (sku, vendor) => ({ competitorSku: sku, vendor });

test('vendor purity keeps the dominant vendor, compared without case', () => {
	const items = [item('A', 'Bilstein'), item('B', 'BILSTEIN'), item('C', 'Bilstein'), item('D', 'Bilstein'), item('E', 'Omix')];
	const result = vendorPurity(items, items.map((i) => i.vendor));
	assert.deepStrictEqual(result.kept.map((i) => i.competitorSku), ['A', 'B', 'C', 'D']);
	assert.strictEqual(result.foreign, 1);
	assert.strictEqual(result.impure, false);
	assert.deepStrictEqual(result.stats, { dominantVendor: 'BILSTEIN' });
});

test('vendor purity drops the whole brand when foreign items pass 25%', () => {
	const items = [item('A', 'Rugged Ridge'), item('B', 'Omix')];
	const result = vendorPurity(items, items.map((i) => i.vendor));
	assert.strictEqual(result.impure, true);
	assert.deepStrictEqual(result.kept, []);
	assert.strictEqual(result.foreign, 1);
});

test('an empty brand is not impure', () => {
	assert.deepStrictEqual(vendorPurity([], []), { kept: [], foreign: 0, impure: false, stats: { dominantVendor: '' } });
});

test('purityRule names the rule and refuses an unknown one', () => {
	assert.strictEqual(purityRule('vendor'), vendorPurity);
	assert.throws(() => purityRule('guess'), /unknown purity rule/);
});
