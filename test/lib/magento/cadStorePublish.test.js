const test = require('node:test');
const assert = require('node:assert');

const {
	dedupePriceRows,
	diffPriceRows,
	collectBasePriceErrors,
	publishExitCode,
} = require('../../../lib/magento/cadStorePublish');

test('keeps the first price row per SKU and store, and reports the duplicates', () => {
	const rows = [
		{ sku: 'A', price: 10, store_id: 0 },
		{ sku: 'A', price: 10, store_id: 1 },
		{ sku: 'A', price: 99, store_id: 0 },
		{ sku: 'B', price: 5, store_id: 0 },
	];

	const result = dedupePriceRows(rows);

	assert.deepStrictEqual(result.rows, [rows[0], rows[1], rows[3]]);
	assert.deepStrictEqual(result.duplicates, [rows[2]]);
});

test('only the rows whose price differs from the store are sent', () => {
	const current = new Map([
		['A', new Map([[0, 10], [1, 12]])],
		['B', new Map([[0, 5]])],
	]);
	const rows = [
		{ sku: 'A', price: 10, store_id: 0 },
		{ sku: 'A', price: 10, store_id: 1 },
		{ sku: 'B', price: 5.004, store_id: 0 },
	];

	const result = diffPriceRows(rows, current);

	assert.deepStrictEqual(result.changed, [rows[1]]);
	assert.deepStrictEqual(result.unchanged, [rows[0], rows[2]]);
});

test('a row whose current price is unknown is sent, never assumed equal', () => {
	const rows = [
		{ sku: 'NEW', price: 10, store_id: 0 },
		{ sku: 'A', price: 10, store_id: 1 },
	];

	const result = diffPriceRows(rows, new Map([['A', new Map([[0, 10]])]]));

	assert.deepStrictEqual(result.changed, rows);
});

test('an empty base-prices answer means every row of the batch was accepted', () => {
	const batch = [{ sku: 'A', price: 10, store_id: 0 }];

	assert.deepStrictEqual(collectBasePriceErrors([], batch), []);
	assert.deepStrictEqual(collectBasePriceErrors(undefined, batch), []);
});

test('a row error inside an HTTP 200 answer is tied back to its SKU', () => {
	const batch = [
		{ sku: 'A', price: 10, store_id: 0 },
		{ sku: 'A', price: 10, store_id: 1 },
		{ sku: 'B', price: 5, store_id: 0 },
	];
	const body = [{ message: 'The product that was requested doesn\'t exist. SKU = %SKU', parameters: ['B'] }];

	const failed = collectBasePriceErrors(body, batch);

	assert.strictEqual(failed.length, 1);
	assert.strictEqual(failed[0].sku, 'B');
	assert.match(failed[0].error, /doesn't exist/);
	assert.match(failed[0].error, /B/);
});

test('a row error that names no SKU of the batch is still reported', () => {
	const failed = collectBasePriceErrors([{ message: 'Invalid attribute', parameters: [] }], [{ sku: 'A', price: 1, store_id: 0 }]);

	assert.deepStrictEqual(failed, [{ sku: '', error: 'Invalid attribute' }]);
});

test('the run fails when a row failed, and a skipped unknown SKU alone does not fail it', () => {
	assert.strictEqual(publishExitCode([]), 0);
	assert.strictEqual(publishExitCode([{ sku: 'X', error: 'SKU not found in Magento', skipped: true }]), 0);
	assert.strictEqual(publishExitCode([{ sku: 'X', skipped: true }, { sku: 'A', error: 'HTTP 429' }]), 1);
});

// Sending a SKU the store does not have can only be rejected, and that
// rejection would fail every weekly run over one stale line in the CSV.
test('a SKU missing from a complete lookup is unknown, and is not sent', () => {
	const rows = [
		{ sku: 'GHOST', price: 10, store_id: 0 },
		{ sku: 'A', price: 11, store_id: 0 },
	];
	const current = new Map([['A', new Map([[0, 10]])]]);

	const result = diffPriceRows(rows, current, { lookupComplete: true });

	assert.deepStrictEqual(result.unknown, [rows[0]]);
	assert.deepStrictEqual(result.changed, [rows[1]]);
});

test('with a lookup that failed in part, a missing SKU is sent rather than called unknown', () => {
	const rows = [{ sku: 'MAYBE', price: 10, store_id: 0 }];

	const result = diffPriceRows(rows, new Map(), { lookupComplete: false });

	assert.deepStrictEqual(result.changed, rows);
	assert.deepStrictEqual(result.unknown, []);
});
