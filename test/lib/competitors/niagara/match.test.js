const test = require('node:test');
const assert = require('node:assert');

const { buildIndexes, matchItems, candidatePartNumbers } = require('../../../../lib/competitors/niagara/match');

const products = [
	{ sku: 'BIL-24-186728', searchable_sku: '24-186728', jj_prefix: 'BIL', status: 1 },
	{ sku: 'BIL-24-285643', searchable_sku: '24-285643', jj_prefix: 'BIL', status: 1 },
	{ sku: 'BIL-24-285643-', searchable_sku: '24-285643-', jj_prefix: 'BIL', status: 0 },
	{ sku: 'RC-55658', searchable_sku: '55658', jj_prefix: 'RC', status: 1 },
	{ sku: 'RR-11420.23', searchable_sku: '11420.23', jj_prefix: 'RR', status: 1 },
	{ sku: 'RR-1142023', searchable_sku: '1142023', jj_prefix: 'RR', status: 1 },
	{ sku: 'BD-SS-300', searchable_sku: 'BD-SS-300', jj_prefix: 'RSE', status: 1 },
];
const brands = [
	{ jjPrefix: 'BIL', skuPrefixes: ['BIL-'] },
	{ jjPrefix: 'RC', skuPrefixes: ['RCS'] },
	{ jjPrefix: 'RR', skuPrefixes: [] },
	{ jjPrefix: 'RSE', skuPrefixes: ['BD-'] },
];
const item = (jjPrefix, competitorSku, price = 10) => ({ jjPrefix, competitorSku, price, url: `https://niagarajeeps.ca/products/${competitorSku.toLowerCase()}` });

test('candidatePartNumbers tries the raw sku first, then each configured prefix stripped', () => {
	assert.deepStrictEqual(candidatePartNumbers('BIL-24-186728', ['BIL-']), [{ partNumber: 'BIL-24-186728', via: 'raw' }, { partNumber: '24-186728', via: 'prefix:BIL-' }]);
	assert.deepStrictEqual(candidatePartNumbers('rcs55658', ['RCS']), [{ partNumber: 'rcs55658', via: 'raw' }, { partNumber: '55658', via: 'prefix:RCS' }]);
	assert.deepStrictEqual(candidatePartNumbers('24-186728', ['BIL-']), [{ partNumber: '24-186728', via: 'raw' }]);
});

test('buildIndexes skips empty and trailing-dash searchable_sku, per jj_prefix', () => {
	const indexes = buildIndexes(products);
	assert.deepStrictEqual([...indexes.keys()].sort(), ['BIL', 'RC', 'RR', 'RSE']);
	assert.strictEqual(indexes.get('BIL').get('24285643').length, 1);
});

test('a bare part number and a prefixed one both match our product', () => {
	const result = matchItems([item('BIL', '24-186728'), item('RC', 'RCS55658')], { indexes: buildIndexes(products), brands });
	assert.deepStrictEqual(result.rows.map((r) => [r.product_sku, r.competitor_sku]), [['BIL-24-186728', '24-186728'], ['RC-55658', 'RCS55658']]);
	assert.deepStrictEqual(result.rows[1], { product_sku: 'RC-55658', competitor_sku: 'RCS55658', competitor_price: 10, product_url: 'https://niagarajeeps.ca/products/rcs55658' });
	assert.strictEqual(result.byBrand.RC.viaPrefix, 1);
});

test('the raw sku wins over a stripped prefix when both would match', () => {
	const result = matchItems([item('RSE', 'BD-SS-300')], { indexes: buildIndexes(products), brands });
	assert.strictEqual(result.rows[0].product_sku, 'BD-SS-300');
	assert.strictEqual(result.byBrand.RSE.viaPrefix, 0);
});

test('an unknown part number is unmatched and reported, never written', () => {
	const result = matchItems([item('BIL', 'BIL-99-999999'), item('XXX', 'X-1')], { indexes: buildIndexes(products), brands });
	assert.deepStrictEqual(result.rows, []);
	assert.deepStrictEqual(result.unmatched.map((u) => u.competitorSku), ['BIL-99-999999', 'X-1']);
});

test('dots are kept, so 11420.23 and 1142023 stay different parts', () => {
	const result = matchItems([item('RR', '11420.23')], { indexes: buildIndexes(products), brands });
	assert.strictEqual(result.rows[0].product_sku, 'RR-11420.23');
	assert.deepStrictEqual(result.ambiguous, []);
});

test('two Niagara skus on one of our products: one row, the exact spelling wins, the other is a collision', () => {
	const result = matchItems([item('BIL', '24 285643', 5), item('BIL', 'BIL-24-285643', 9)], { indexes: buildIndexes(products), brands });
	assert.deepStrictEqual(result.rows.map((r) => r.competitor_sku), ['BIL-24-285643']);
	assert.deepStrictEqual(result.collisions.map((c) => [c.competitorSku, c.productSku, c.keptSku]), [['24 285643', 'BIL-24-285643', 'BIL-24-285643']]);
	assert.strictEqual(result.byBrand.BIL.collisions, 1);
});

// The winner must not depend on price: rows are keyed on competitor_sku and
// never deleted, so a winner that flips with the price leaves the old row
// behind with a frozen price.
test('the same part listed bare and behind their code keeps the bare spelling, whatever the prices', () => {
	for (const [bare, coded] of [[9, 5], [5, 9]]) {
		const result = matchItems([item('BIL', 'BIL-24-285643', coded), item('BIL', '24-285643', bare)], { indexes: buildIndexes(products), brands });
		assert.deepStrictEqual(result.rows.map((r) => [r.competitor_sku, r.competitor_price]), [['24-285643', bare]]);
	}
});

test('a collision with no exact spelling keeps the same spelling whatever the prices', () => {
	for (const [a, b] of [[9, 7], [7, 9]]) {
		const result = matchItems([item('BIL', '24 186728', a), item('BIL', '24_186728', b)], { indexes: buildIndexes(products), brands });
		assert.deepStrictEqual(result.rows.map((r) => r.competitor_sku), ['24 186728']);
	}
});

test('the same spelling listed twice keeps the cheaper price (same row either way)', () => {
	const result = matchItems([item('BIL', '24-285643', 9), item('BIL', '24-285643', 5)], { indexes: buildIndexes(products), brands });
	assert.deepStrictEqual(result.rows.map((r) => [r.competitor_sku, r.competitor_price]), [['24-285643', 5]]);
});

test('one Niagara sku matching products in two brands is written for neither', () => {
	const shared = [...products, { sku: 'RC-24-186728', searchable_sku: '24-186728', jj_prefix: 'RC', status: 1 }];
	const result = matchItems([item('BIL', '24-186728', 10), item('RC', '24-186728', 20), item('RC', '55658')], { indexes: buildIndexes(shared), brands });
	assert.deepStrictEqual(result.rows.map((r) => r.competitor_sku), ['55658']);
	assert.deepStrictEqual(result.collisions.filter((c) => c.reason === 'same-sku-in-two-brands').map((c) => c.productSku).sort(), ['BIL-24-186728', 'RC-24-186728']);
	assert.strictEqual(result.byBrand.BIL.matched, 0);
	assert.strictEqual(result.byBrand.RC.matched, 1);
	assert.strictEqual(result.byBrand.BIL.collisions, 1);
});

test('byBrand counts matched and unmatched per jj_prefix', () => {
	const result = matchItems([item('BIL', '24-186728'), item('BIL', 'nope')], { indexes: buildIndexes(products), brands });
	assert.deepStrictEqual(result.byBrand.BIL, { items: 2, matched: 1, unmatched: 1, viaPrefix: 0, collisions: 0 });
});
