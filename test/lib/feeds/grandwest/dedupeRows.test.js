const test = require('node:test');
const assert = require('node:assert');

const { dropRepeatedItems } = require('../../../../lib/feeds/grandwest/dedupeRows');

const row = (item, cost) => ({ item, lineCode: item.split('-')[0], part: item.slice(4), cost, stock: 1, stockText: '1' });

test('an Item listed twice with two prices is dropped entirely: no price is guessed', () => {
	const rows = [row('TYG-A1', 829), row('BDS-1', 10), row('TYG-A1', 779), row('ERI-2', 5)];

	const { rows: kept, duplicates } = dropRepeatedItems(rows);

	assert.deepStrictEqual(kept.map((r) => r.item), ['BDS-1', 'ERI-2']);
	assert.deepStrictEqual(duplicates, [
		{ item: 'TYG-A1', lineCode: 'TYG', reason: 'duplicate-item', copies: 2 },
	]);
});

test('Items that differ only in case or spaces count as the same Item', () => {
	const { rows: kept, duplicates } = dropRepeatedItems([row('IRO-12830007GR LH', 1), row('iro-12830007gr  lh', 2)]);

	assert.deepStrictEqual(kept, []);
	assert.strictEqual(duplicates.length, 1);
	assert.strictEqual(duplicates[0].copies, 2);
});

test('a file with no repeats is returned unchanged and in order', () => {
	const rows = [row('BDS-1', 1), row('BDS-2', 2)];
	assert.deepStrictEqual(dropRepeatedItems(rows), { rows, duplicates: [] });
});

test('an Item repeated with one invalid copy is still dropped: the valid copy is not trusted', () => {
	const rows = [row('TYG-A1', 779), row('BDS-1', 10)];
	const invalid = [{ item: 'TYG-A1', lineCode: 'TYG', reason: 'bad-cost' }];

	const { rows: kept, duplicates } = dropRepeatedItems(rows, invalid);

	assert.deepStrictEqual(kept.map((r) => r.item), ['BDS-1']);
	assert.deepStrictEqual(duplicates, [{ item: 'TYG-A1', lineCode: 'TYG', reason: 'duplicate-item', copies: 2 }]);
});

test('an invalid row alone is not a repeat', () => {
	const { rows: kept, duplicates } = dropRepeatedItems([row('BDS-1', 10)], [{ item: 'AFE-9', lineCode: 'AFE', reason: 'bad-cost' }]);
	assert.deepStrictEqual([kept.length, duplicates], [1, []]);
});
