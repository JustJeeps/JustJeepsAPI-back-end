const test = require('node:test');
const assert = require('node:assert');

const { canonicalPartNumber, buildProductIndex, matchPartNumber } = require('../../../lib/competitors/skuMatch');

const products = [
	{ sku: 'RC-63470', searchable_sku: '63470', status: 1 },
	{ sku: 'RC-2620_RED', searchable_sku: '2620_RED', status: 1 },
	{ sku: 'RC-330.20', searchable_sku: '330.20', status: 1 },
	{ sku: 'RC-33020', searchable_sku: '33020', status: 1 },
	{ sku: 'RC-10497A', searchable_sku: '10497A', status: 0 },
	{ sku: 'RC-10497-A', searchable_sku: '10497-A', status: 1 },
];

// JJ writes 2620_RED, Parts Engine 2620-RED, Lowriders 28230RED: separators
// differ between sources, dots do not.
test('canonical form drops dashes, underscores and space, keeps dots, uppercases', () => {
	assert.strictEqual(canonicalPartNumber(' 2620-red '), '2620RED');
	assert.strictEqual(canonicalPartNumber('2620_RED'), '2620RED');
	assert.strictEqual(canonicalPartNumber('330.20'), '330.20');
	assert.strictEqual(canonicalPartNumber(null), '');
});

test('330.20 and 33020 never collide', () => {
	const index = buildProductIndex(products);
	assert.strictEqual(matchPartNumber(index, '330.20').sku, 'RC-330.20');
	assert.strictEqual(matchPartNumber(index, '33020').sku, 'RC-33020');
});

test('separator variants match the same product', () => {
	const index = buildProductIndex(products);
	assert.strictEqual(matchPartNumber(index, '2620RED').sku, 'RC-2620_RED');
	assert.strictEqual(matchPartNumber(index, '2620-RED').sku, 'RC-2620_RED');
});

test('unknown part numbers are unmatched', () => {
	const index = buildProductIndex(products);
	assert.deepStrictEqual(matchPartNumber(index, 'NOPE'), { status: 'unmatched', sku: null, candidates: [] });
	assert.strictEqual(matchPartNumber(index, '').status, 'unmatched');
});

// Two products share a canonical form: exact raw match wins, then active
// status, then the smallest sku. Deterministic so two runs agree.
test('ambiguous candidates are resolved deterministically and flagged', () => {
	const index = buildProductIndex(products);
	const exact = matchPartNumber(index, '10497A');
	assert.strictEqual(exact.status, 'ambiguous');
	assert.strictEqual(exact.sku, 'RC-10497A');
	assert.strictEqual(exact.candidates.length, 2);

	const noExact = matchPartNumber(index, '10497 A');
	assert.strictEqual(noExact.sku, 'RC-10497-A', 'no raw equality, so the active product wins');
});

test('products without a searchable_sku are ignored by the index', () => {
	const index = buildProductIndex([{ sku: 'RC-X', searchable_sku: null, status: 1 }, { sku: 'RC-Y', searchable_sku: '', status: 1 }]);
	assert.strictEqual(index.size, 0);
});
