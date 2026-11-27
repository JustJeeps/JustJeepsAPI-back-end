const test = require('node:test');
const assert = require('node:assert');

const {
	ATTRIBUTE_CODES,
	buildAttributeValues,
	sameAttributeValue,
	diffAttributeRows,
	buildSkuLookupQuery,
	indexCurrentValues,
} = require('../../../lib/magento/vendorAttributesDelta');

const RATE = 1.25;

test('converts the vendor cost to USD with two decimals', () => {
	const values = buildAttributeValues({ vendor_cost: 100, vendor_inventory: 7 }, RATE);

	assert.deepStrictEqual(values, { cost_usd: '80.00', inventory_vendor: '7' });
});

test('falls back to the inventory string, then to NO INFO, when there is no number', () => {
	const withString = buildAttributeValues(
		{ vendor_cost: 10, vendor_inventory: null, vendor_inventory_string: 'Backorder' },
		RATE
	);
	const withNothing = buildAttributeValues({ vendor_cost: 10, vendor_inventory: undefined }, RATE);

	assert.strictEqual(withString.inventory_vendor, 'Backorder');
	assert.strictEqual(withNothing.inventory_vendor, 'NO INFO');
});

test('Rough Country zero stock uses the inventory string, other vendors keep the zero', () => {
	const product = { vendor_cost: 10, vendor_inventory: 0, vendor_inventory_string: 'Ships in 5 days' };

	const rough = buildAttributeValues({ ...product, vendor_name: 'Rough Country' }, RATE);
	const other = buildAttributeValues({ ...product, vendor_name: 'KeyParts' }, RATE);

	assert.strictEqual(rough.inventory_vendor, 'Ships in 5 days');
	assert.strictEqual(other.inventory_vendor, '0');
});

test('numbers are equal when they agree to the cent, whatever the formatting', () => {
	assert.strictEqual(sameAttributeValue('12.30', '12.3'), true);
	assert.strictEqual(sameAttributeValue('5', '5.0000'), true);
	assert.strictEqual(sameAttributeValue('12.30', '12.31'), false);
});

test('text values are compared trimmed, and a missing value is never equal', () => {
	assert.strictEqual(sameAttributeValue('NO INFO', ' NO INFO '), true);
	assert.strictEqual(sameAttributeValue('Backorder', '0'), false);
	assert.strictEqual(sameAttributeValue('0', undefined), false);
	assert.strictEqual(sameAttributeValue('0', ''), false);
});

test('only the SKUs whose cost or inventory differs from the store are sent', () => {
	const rows = [
		{ sku: 'SAME', values: { cost_usd: '10.00', inventory_vendor: '3' } },
		{ sku: 'COST', values: { cost_usd: '11.00', inventory_vendor: '3' } },
		{ sku: 'STOCK', values: { cost_usd: '10.00', inventory_vendor: '4' } },
	];
	const current = new Map([
		['same', { cost_usd: '10', inventory_vendor: '3' }],
		['cost', { cost_usd: '10', inventory_vendor: '3' }],
		['stock', { cost_usd: '10', inventory_vendor: '3' }],
	]);

	const result = diffAttributeRows(rows, current);

	assert.deepStrictEqual(result.unchanged.map((r) => r.sku), ['SAME']);
	assert.deepStrictEqual(result.changed.map((r) => r.sku), ['COST', 'STOCK']);
	assert.deepStrictEqual(result.notFound, []);
});

test('a SKU the lookup did not return is still sent, never assumed unchanged', () => {
	const rows = [{ sku: 'GONE', values: { cost_usd: '1.00', inventory_vendor: '1' } }];

	const result = diffAttributeRows(rows, new Map());

	assert.deepStrictEqual(result.changed.map((r) => r.sku), ['GONE']);
	assert.deepStrictEqual(result.notFound.map((r) => r.sku), ['GONE']);
});

test('the SKU match ignores case, as Magento does', () => {
	const rows = [{ sku: 'Abc-1', values: { cost_usd: '1.00', inventory_vendor: '1' } }];
	const current = indexCurrentValues([
		{ sku: 'ABC-1', custom_attributes: [
			{ attribute_code: 'cost_usd', value: '1.00' },
			{ attribute_code: 'inventory_vendor', value: '1' },
		] },
	]);

	assert.deepStrictEqual(diffAttributeRows(rows, current).unchanged.map((r) => r.sku), ['Abc-1']);
});

test('reads the attributes whether Magento answers a list or an object keyed by index', () => {
	const current = indexCurrentValues([
		{ sku: 'A', custom_attributes: { 0: { attribute_code: 'cost_usd', value: '2.50' } } },
		{ sku: 'B' },
		{ custom_attributes: [] },
	]);

	assert.deepStrictEqual(current.get('a'), { cost_usd: '2.50', inventory_vendor: '' });
	assert.deepStrictEqual(current.get('b'), { cost_usd: '', inventory_vendor: '' });
	assert.strictEqual(current.size, 2);
});

test('the lookup asks for exactly the batch SKUs and only the two attributes', () => {
	const params = buildSkuLookupQuery(['A-1', 'B 2']);

	assert.strictEqual(params['searchCriteria[filter_groups][0][filters][0][field]'], 'sku');
	assert.strictEqual(params['searchCriteria[filter_groups][0][filters][0][value]'], 'A-1,B 2');
	assert.strictEqual(params['searchCriteria[filter_groups][0][filters][0][condition_type]'], 'in');
	assert.strictEqual(params['searchCriteria[pageSize]'], 2);
	assert.strictEqual(params.fields, `items[sku,custom_attributes[${ATTRIBUTE_CODES.join(',')}]]`);
});
