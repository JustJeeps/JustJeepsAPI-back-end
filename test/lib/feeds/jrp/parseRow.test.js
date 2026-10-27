const test = require('node:test');
const assert = require('node:assert');

const { parseRow, INVALID_REASONS } = require('../../../../lib/feeds/jrp/parseRow');

const OPTIONS = { stockPlusValue: 4 };

const raw = (overrides = {}) => ({
	BRAND: 'AlphaRex',
	JRPSKU: 'ARX210081',
	OEMSKU: '210081',
	DESCRIPTION: 'AlphaRex Wiring Adapter',
	'IN-STOCK': '2',
	COST: '53.76',
	MAP: '64.92',
	...overrides,
});

test('a clean row parses into numbers and trimmed text', () => {
	const result = parseRow(raw({ BRAND: '  AlphaRex ', OEMSKU: ' 210081 ' }), OPTIONS);
	assert.deepStrictEqual(result, {
		ok: true,
		row: {
			brandLabel: 'AlphaRex',
			jrpSku: 'ARX210081',
			oemSku: '210081',
			description: 'AlphaRex Wiring Adapter',
			stock: 2,
			stockText: '2',
			cost: 53.76,
			map: 64.92,
			mapBelowCost: false,
		},
	});
});

test('IN-STOCK 4+ becomes the configured plus value and keeps the raw text', () => {
	const result = parseRow(raw({ 'IN-STOCK': '4+' }), OPTIONS);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.row.stock, 4);
	assert.strictEqual(result.row.stockText, '4+');
});

test('IN-STOCK 0 to 3 parse as integers', () => {
	for (const text of ['0', '1', '2', '3']) {
		assert.strictEqual(parseRow(raw({ 'IN-STOCK': text }), OPTIONS).row.stock, Number(text));
	}
});

test('any other IN-STOCK value is invalid', () => {
	for (const text of ['5', '4', '-1', '', '2.5', 'many', '10+']) {
		assert.deepStrictEqual(parseRow(raw({ 'IN-STOCK': text }), OPTIONS), { ok: false, reason: 'bad-stock' }, text);
	}
});

test('COST must be a finite non-negative number', () => {
	for (const text of ['', 'abc', '-1.00', '1,234.00', 'NaN', 'Infinity', undefined]) {
		assert.deepStrictEqual(parseRow(raw({ COST: text }), OPTIONS), { ok: false, reason: 'bad-cost' }, String(text));
	}
	assert.strictEqual(parseRow(raw({ COST: '0' }), OPTIONS).row.cost, 0);
});

test('MAP must be numeric, otherwise the row is invalid', () => {
	for (const text of ['', 'n/a', undefined]) {
		assert.deepStrictEqual(parseRow(raw({ MAP: text }), OPTIONS), { ok: false, reason: 'bad-map' }, String(text));
	}
});

test('a negative MAP (the -0.01 "no MAP" sentinel) keeps the row with map null, flagged below cost', () => {
	const result = parseRow(raw({ MAP: '-0.01' }), OPTIONS);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.row.map, null);
	assert.strictEqual(result.row.mapBelowCost, true);
});

test('MAP below COST is kept and flagged', () => {
	const result = parseRow(raw({ COST: '31.52', MAP: '30.00' }), OPTIONS);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.row.mapBelowCost, true);
	assert.strictEqual(parseRow(raw({ COST: '31.52', MAP: '31.52' }), OPTIONS).row.mapBelowCost, false);
});

test('missing identifiers are invalid with their own reason', () => {
	assert.deepStrictEqual(parseRow(raw({ OEMSKU: '  ' }), OPTIONS), { ok: false, reason: 'missing-oemsku' });
	assert.deepStrictEqual(parseRow(raw({ OEMSKU: undefined }), OPTIONS), { ok: false, reason: 'missing-oemsku' });
	assert.deepStrictEqual(parseRow(raw({ JRPSKU: '' }), OPTIONS), { ok: false, reason: 'missing-jrpsku' });
	assert.deepStrictEqual(parseRow(raw({ BRAND: '' }), OPTIONS), { ok: false, reason: 'missing-brand' });
});

test('every reason returned is listed in INVALID_REASONS', () => {
	assert.deepStrictEqual([...INVALID_REASONS].sort(), ['bad-cost', 'bad-map', 'bad-stock', 'missing-brand', 'missing-jrpsku', 'missing-oemsku']);
	assert.ok(Object.isFrozen(INVALID_REASONS));
});
