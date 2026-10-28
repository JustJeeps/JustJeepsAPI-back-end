const test = require('node:test');
const assert = require('node:assert');

const { dedupeByJrpSku } = require('../../../../lib/feeds/jrp/dedupeRows');

const row = (jrpSku, cost) => ({ brandLabel: 'Bilstein', jrpSku, oemSku: '10-255605', cost, stock: 0, stockText: '0' });

test('the first copy of a repeated JRPSKU is kept, the others are listed in feed order', () => {
	const { rows, duplicates } = dedupeByJrpSku([row('BIL1', 837.05), row('BIL2', 10), row('BIL1', 1), row('BIL1', 2)]);
	assert.deepStrictEqual(rows.map((r) => [r.jrpSku, r.cost]), [['BIL1', 837.05], ['BIL2', 10]]);
	assert.deepStrictEqual(duplicates, [
		{ brandLabel: 'Bilstein', jrpSku: 'BIL1', oemSku: '10-255605', reason: 'duplicate-jrpsku' },
		{ brandLabel: 'Bilstein', jrpSku: 'BIL1', oemSku: '10-255605', reason: 'duplicate-jrpsku' },
	]);
});

test('JRPSKU comparison is exact: a case variant is another vendor_sku, not a duplicate', () => {
	const { rows, duplicates } = dedupeByJrpSku([row('BIL1', 1), row('bil1', 2)]);
	assert.strictEqual(rows.length, 2);
	assert.deepStrictEqual(duplicates, []);
});

test('the input is not mutated', () => {
	const input = Object.freeze([Object.freeze(row('BIL1', 1))]);
	const { rows } = dedupeByJrpSku(input);
	assert.notStrictEqual(rows, input);
	assert.deepStrictEqual(rows, [row('BIL1', 1)]);
});
