const test = require('node:test');
const assert = require('node:assert');

const { toLegacyRows } = require('../../../../lib/competitors/tdot/legacyAdapter');

test('toLegacyRows emits exactly the contract seed-tdot.js consumes', () => {
	const payload = {
		items: [
			{ tdotCode: 'Bestop 52401-11', productSku: 'BST-52401-11', partNumber: '52401-11', effectivePrice: 343.98, url: 'https://www.tdotperformance.ca/products/x' },
			{ tdotCode: 'Omix-ADA 82903.22', productSku: 'OA-82903.22', partNumber: '82903.22', effectivePrice: 12.5, url: null },
		],
	};
	assert.deepStrictEqual(toLegacyRows(payload), [
		{ tdot_price: 343.98, tdot_code: 'Bestop 52401-11', sku: '52401-11', brand: 'Bestop', product_url: 'https://www.tdotperformance.ca/products/x' },
		{ tdot_price: 12.5, tdot_code: 'Omix-ADA 82903.22', sku: '82903.22', brand: 'Omix-ADA', product_url: null },
	]);
	assert.deepStrictEqual(toLegacyRows({ items: [] }), []);
});
