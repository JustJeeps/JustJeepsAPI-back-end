const test = require('node:test');
const assert = require('node:assert');

const { suggestBrandMatch, inferSkuPrefix, dominantVendor } = require('../../../../lib/competitors/niagara/brandMap');

const ours = [
	{ jj_prefix: '', brand_name: '' },
	{ jj_prefix: 'AFE', brand_name: 'aFe Power' },
	{ jj_prefix: 'BOR', brand_name: 'Borla Performance' },
	{ jj_prefix: 'FOX', brand_name: 'Fox Racing' },
	{ jj_prefix: 'EXP', brand_name: 'PRO COMP Suspension' },
	{ jj_prefix: 'PCT', brand_name: 'Pro Comp Tires' },
	{ jj_prefix: 'PCT', brand_name: 'Pro Comp Tire' },
	{ jj_prefix: 'K&N', brand_name: 'K&N' },
];

test('same name after dropping case and punctuation is an exact match', () => {
	const result = suggestBrandMatch({ label: 'AFE POWER', labels: ['AFE POWER'] }, ours);
	assert.strictEqual(result.tier, 'exact');
	assert.deepStrictEqual(result.candidates.map((c) => c.jj_prefix), ['AFE']);
});

test('a name equal after dropping generic words is a loose match', () => {
	assert.deepStrictEqual(suggestBrandMatch({ label: 'BORLA', labels: ['BORLA'] }, ours).tier, 'loose');
	assert.deepStrictEqual(suggestBrandMatch({ label: 'FOX', labels: ['FOX'] }, ours).candidates.map((c) => c.jj_prefix), ['FOX']);
	assert.deepStrictEqual(suggestBrandMatch({ label: 'K&N FILTERS', labels: ['K&N FILTERS'] }, ours).candidates.map((c) => c.jj_prefix), ['K&N']);
});

test('more than one of our prefixes is ambiguous, one row per prefix', () => {
	const result = suggestBrandMatch({ label: 'PRO COMP', labels: ['PRO COMP'] }, ours);
	assert.strictEqual(result.tier, 'ambiguous');
	assert.deepStrictEqual(result.candidates.map((c) => c.jj_prefix), ['EXP', 'PCT']);
});

test('a brand we do not carry is unmapped', () => {
	const result = suggestBrandMatch({ label: 'NEBO', labels: ['NEBO'] }, ours);
	assert.strictEqual(result.tier, 'unmapped');
	assert.deepStrictEqual(result.candidates, []);
});

test('inferSkuPrefix finds the dash prefix, the letters-only prefix and the bare part number', () => {
	assert.deepStrictEqual(inferSkuPrefix(['BIL-41-324158', 'BIL-24-186728', 'BIL-33-292984']), { prefix: 'BIL-', share: 1, samples: ['BIL-41-324158', 'BIL-24-186728', 'BIL-33-292984'] });
	assert.strictEqual(inferSkuPrefix(['RCS55658', 'RCS1234', 'RCS-9']).prefix, 'RCS');
	assert.strictEqual(inferSkuPrefix(['11420.23', '13551.01']).prefix, '');
	assert.strictEqual(inferSkuPrefix(['WARN-95510', 'WARN-103255']).prefix, 'WARN-');
});

test('inferSkuPrefix reports the share of the most common prefix', () => {
	const result = inferSkuPrefix(['MOT-1', 'MOT-2', 'MOT-3', 'MEG-4']);
	assert.strictEqual(result.prefix, 'MOT-');
	assert.strictEqual(result.share, 0.75);
});

test('inferSkuPrefix of nothing is an empty prefix with share 0', () => {
	assert.deepStrictEqual(inferSkuPrefix([]), { prefix: '', share: 0, samples: [] });
});

test('dominantVendor groups labels that differ only in case', () => {
	assert.deepStrictEqual(dominantVendor(['METRA', 'Metra', 'Other']), { vendor: 'METRA', share: 2 / 3 });
	assert.deepStrictEqual(dominantVendor([]), { vendor: '', share: 0 });
});
