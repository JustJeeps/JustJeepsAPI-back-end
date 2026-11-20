const test = require('node:test');
const assert = require('node:assert');

const { codeOf, codeShares } = require('../../../../lib/competitors/shopify/skuCode');
const { skuCodePurity, purityRule } = require('../../../../lib/competitors/shopify/purity');

const item = (competitorSku, vendor = 'Warn') => ({ competitorSku, vendor });
const brand = (skuPrefixes) => ({ jjPrefix: 'WAR', handle: 'warn', skuPrefixes });

test('codeOf reads the 4-letter distributor code in front of the part number', () => {
	assert.strictEqual(codeOf('BBGL_24-329248'), 'BBGL_');
	assert.strictEqual(codeOf('dhtp_52200_a'), 'DHTP_');
	assert.strictEqual(codeOf('BKGF_18290.08'), 'BKGF_');
	assert.strictEqual(codeOf('afe56-70061R'), '');
	assert.strictEqual(codeOf('AB_123'), '');
	assert.strictEqual(codeOf('BBGL_'), '');
	assert.strictEqual(codeOf(null), '');
});

test('codeShares gives the dominant code among coded SKUs and the coded share', () => {
	assert.deepStrictEqual(codeShares(['BBGL_1', 'BBGL_2', 'BBGL_3', 'XXXX_4', 'plain']), { code: 'BBGL_', share: 0.75, codedShare: 0.8, coded: 4, total: 5 });
	assert.deepStrictEqual(codeShares([]), { code: '', share: 0, codedShare: 0, coded: 0, total: 0 });
});

test('a brand whose vendor text varies is kept whole when the SKU code is its own', () => {
	const items = [item('BCSQ_100970', 'WARN IND.'), item('BCSQ_100969', 'Warn'), item('BCSQ_101255', 'Warn')];
	const result = skuCodePurity(items, items.map((i) => i.vendor), brand(['BCSQ_']));
	assert.strictEqual(result.kept.length, 3);
	assert.strictEqual(result.foreign, 0);
	assert.strictEqual(result.impure, false);
	assert.deepStrictEqual(result.stats, { dominantVendor: 'WARN', uncoded: 0, uncodedSample: [] });
});

test('foreign codes are dropped and SKUs without a code are dropped and counted', () => {
	const items = [item('BCSQ_1'), item('BCSQ_2'), item('BCSQ_3'), item('BCSQ_4'), item('ZZZZ_5'), item('plain-6')];
	const result = skuCodePurity(items, items.map((i) => i.vendor), brand(['BCSQ_']));
	assert.deepStrictEqual(result.kept.map((i) => i.competitorSku), ['BCSQ_1', 'BCSQ_2', 'BCSQ_3', 'BCSQ_4']);
	assert.strictEqual(result.foreign, 1);
	assert.strictEqual(result.stats.uncoded, 1);
	assert.deepStrictEqual(result.stats.uncodedSample, ['plain-6']);
	assert.strictEqual(result.impure, false);
});

test('a brand is impure when foreign codes pass 25% of the coded items', () => {
	const items = [item('BCSQ_1'), item('BCSQ_2'), item('ZZZZ_3')];
	const result = skuCodePurity(items, items.map((i) => i.vendor), brand(['BCSQ_']));
	assert.strictEqual(result.impure, true);
	assert.deepStrictEqual(result.kept, []);
});

test('a brand with no item of its own is impure, so a wrong mapping fails loud', () => {
	const items = [item('ZZZZ_1'), item('plain')];
	assert.strictEqual(skuCodePurity(items, ['x', 'y'], brand(['BCSQ_'])).impure, true);
	assert.strictEqual(skuCodePurity(items, ['x', 'y'], brand([])).impure, true);
});

test('a second configured prefix is accepted and an empty brand is not impure', () => {
	const items = [item('BKJC_50-1'), item('AFE56-2')];
	assert.strictEqual(skuCodePurity(items, ['aFe', 'AFE'], brand(['BKJC_', 'AFE'])).kept.length, 2);
	assert.deepStrictEqual(skuCodePurity([], [], brand(['BKJC_'])), { kept: [], foreign: 0, impure: false, stats: { dominantVendor: '', uncoded: 0, uncodedSample: [] } });
});

test('the uncoded sample keeps the first five SKUs without a code, so a second listing scheme is visible', () => {
	const items = ['MISA1', 'MISA2', 'MISA3', 'MISA4', 'MISA5', 'MISA6'].map((sku) => item(sku, 'Mishimoto'));
	assert.deepStrictEqual(skuCodePurity([item('FLDS_1', 'Mishimoto'), ...items], [], brand(['FLDS_'])).stats.uncodedSample, ['MISA1', 'MISA2', 'MISA3', 'MISA4', 'MISA5']);
	assert.strictEqual(skuCodePurity([item('FLDS_1', 'Mishimoto'), ...items], [], brand(['FLDS_', 'MIS'])).stats.uncoded, 0);
});

test('purityRule knows the sku-code rule', () => {
	assert.strictEqual(purityRule('sku-code'), skuCodePurity);
});
