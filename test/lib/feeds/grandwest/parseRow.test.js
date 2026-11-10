const test = require('node:test');
const assert = require('node:assert');

const { parseRow, INVALID_REASONS } = require('../../../../lib/feeds/grandwest/parseRow');

const raw = (overrides = {}) => ({
	Item: 'BDS-001401',
	LineCode: 'BDS',
	Desciption: 'FRONT SPRING 4" 73-91 GM',
	UnitPrice: '235.48',
	ListPrice: '322.6',
	Quantity: '3',
	UPC: '843870011218',
	...overrides,
});

test('a full row becomes the item, its line code, its part number, cost and stock', () => {
	assert.deepStrictEqual(parseRow(raw()), {
		ok: true,
		row: { item: 'BDS-001401', lineCode: 'BDS', part: '001401', cost: 235.48, stock: 3, stockText: '3' },
	});
});

test('a blank quantity means out of stock (Grandwest never sends 0)', () => {
	const { row } = parseRow(raw({ Quantity: '' }));
	assert.strictEqual(row.stock, 0);
	assert.strictEqual(row.stockText, '0');
	assert.strictEqual(parseRow(raw({ Quantity: '   ' })).row.stock, 0);
});

test('a fractional quantity is rounded down to whole units', () => {
	assert.strictEqual(parseRow(raw({ Quantity: '6.83333' })).row.stock, 6);
	assert.strictEqual(parseRow(raw({ Quantity: '0.875' })).row.stock, 0);
});

test('spaces around values are trimmed and the line code is uppercased', () => {
	const { row } = parseRow(raw({ Item: ' iro-12830007GR LH ', LineCode: ' iro ' }));
	assert.strictEqual(row.item, 'iro-12830007GR LH');
	assert.strictEqual(row.lineCode, 'IRO');
	assert.strictEqual(row.part, '12830007GR LH');
});

test('a zero or missing cost is rejected: it would show as the cheapest vendor', () => {
	assert.deepStrictEqual(parseRow(raw({ UnitPrice: '0' })), { ok: false, reason: 'bad-cost' });
	assert.deepStrictEqual(parseRow(raw({ UnitPrice: '' })), { ok: false, reason: 'bad-cost' });
	assert.deepStrictEqual(parseRow(raw({ UnitPrice: '12,50' })), { ok: false, reason: 'bad-cost' });
	assert.deepStrictEqual(parseRow(raw({ UnitPrice: '-3' })), { ok: false, reason: 'bad-cost' });
});

test('a quantity that is not a number, or is negative, is rejected', () => {
	assert.deepStrictEqual(parseRow(raw({ Quantity: 'many' })), { ok: false, reason: 'bad-quantity' });
	assert.deepStrictEqual(parseRow(raw({ Quantity: '-1' })), { ok: false, reason: 'bad-quantity' });
});

test('an item that does not start with its line code is rejected', () => {
	assert.deepStrictEqual(parseRow(raw({ Item: 'XYZ-001401' })), { ok: false, reason: 'item-prefix-mismatch' });
	assert.deepStrictEqual(parseRow(raw({ Item: 'BDS-' })), { ok: false, reason: 'item-prefix-mismatch' });
	assert.deepStrictEqual(parseRow(raw({ Item: 'BDS001401' })), { ok: false, reason: 'item-prefix-mismatch' });
});

test('a missing item or line code is rejected', () => {
	assert.deepStrictEqual(parseRow(raw({ Item: '' })), { ok: false, reason: 'missing-item' });
	assert.deepStrictEqual(parseRow(raw({ LineCode: ' ' })), { ok: false, reason: 'missing-line-code' });
	assert.deepStrictEqual(parseRow({}), { ok: false, reason: 'missing-item' });
});

test('every reason returned is a declared reason', () => {
	assert.deepStrictEqual([...INVALID_REASONS].sort(), ['bad-cost', 'bad-quantity', 'item-prefix-mismatch', 'missing-item', 'missing-line-code']);
});
