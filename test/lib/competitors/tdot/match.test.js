const test = require('node:test');
const assert = require('node:assert');

const { canonicalTdotCode, buildTargetIndex, matchItems } = require('../../../../lib/competitors/tdot/match');

const targets = [
	{ sku: 'BST-52401-11', searchable_sku: '52401-11', tdot_code: 'Bestop 52401-11', status: 1 },
	{ sku: 'OA-82903.22', searchable_sku: '82903.22', tdot_code: 'Omix-ADA 82903.22', status: 1 },
	{ sku: 'RR-11540.13', searchable_sku: '11540.13', tdot_code: 'Rugged Ridge 11540.13', status: 1 },
	{ sku: 'KDA-123', searchable_sku: '123', tdot_code: 'K&N 123', status: 1 },
	{ sku: 'K&N-123', searchable_sku: '123', tdot_code: 'K&N 123', status: 0 },
];

const item = (competitorSku, price = 10, extra = {}) => ({ competitorSku, skuToken: competitorSku.replace(' ', '-'), effectivePrice: price, url: 'u', ...extra });

test('canonicalTdotCode ignores separators and case but keeps dots', () => {
	assert.strictEqual(canonicalTdotCode('Bestop 52401-11'), 'BESTOP5240111');
	assert.strictEqual(canonicalTdotCode('Bestop-52401-11'), 'BESTOP5240111');
	assert.strictEqual(canonicalTdotCode('Omix-ADA 82903.22'), 'OMIXADA82903.22');
	assert.strictEqual(canonicalTdotCode('OmixADA-82903.22'), 'OMIXADA82903.22');
	assert.notStrictEqual(canonicalTdotCode('Rugged Ridge 11540.13'), canonicalTdotCode('Rugged Ridge 1154013'));
});

test('matchItems links a TDOT item to our product by canonical tdot_code and emits OUR tdot_code', () => {
	const index = buildTargetIndex(targets);
	const result = matchItems([item('Bestop 52401-11', 343.98), item('OmixADA 82903.22'), item('Rugged Ridge 11540.61')], index);
	assert.deepStrictEqual(result.matched.map((m) => [m.tdotCode, m.productSku, m.item.competitorSku]), [
		['Bestop 52401-11', 'BST-52401-11', 'Bestop 52401-11'],
		['Omix-ADA 82903.22', 'OA-82903.22', 'OmixADA 82903.22'],
	]);
	assert.deepStrictEqual(result.unmatched.map((u) => u.competitorSku), ['Rugged Ridge 11540.61']);
});

test('matchItems reports a shared tdot_code (two of our products) once, as ambiguous, and still emits the row', () => {
	const index = buildTargetIndex(targets);
	const result = matchItems([item('K&N 123')], index);
	assert.strictEqual(result.matched.length, 1);
	assert.strictEqual(result.matched[0].tdotCode, 'K&N 123');
	assert.deepStrictEqual(result.matched[0].productSku, 'KDA-123', 'active product first');
	assert.deepStrictEqual(result.ambiguous, [{ tdotCode: 'K&N 123', productSkus: ['KDA-123', 'K&N-123'] }]);
});

test('matchItems never emits the same tdot_code twice: the cheapest item wins', () => {
	const index = buildTargetIndex(targets);
	const result = matchItems([item('Bestop 52401-11', 50), item('Bestop 52401-11', 40, { url: 'other' })], index);
	assert.strictEqual(result.matched.length, 1);
	assert.strictEqual(result.matched[0].item.effectivePrice, 40);
	assert.strictEqual(result.duplicateCount, 1);
});

test('buildTargetIndex skips products without a tdot_code and matchItems handles an empty list', () => {
	const index = buildTargetIndex([{ sku: 'X', tdot_code: '' }, { sku: 'Y', tdot_code: null }]);
	assert.strictEqual(index.size, 0);
	assert.deepStrictEqual(matchItems([], index), { matched: [], unmatched: [], ambiguous: [], duplicateCount: 0 });
});

test('matchItems prefers the item whose competitorSku equals our tdot_code over a cheaper look-alike', () => {
	const index = buildTargetIndex(targets);
	const result = matchItems([item('Bestop-52401-11', 40), item('Bestop 52401-11', 50)], index);
	assert.strictEqual(result.matched[0].item.competitorSku, 'Bestop 52401-11');
	assert.strictEqual(result.matched[0].item.effectivePrice, 50);
});
