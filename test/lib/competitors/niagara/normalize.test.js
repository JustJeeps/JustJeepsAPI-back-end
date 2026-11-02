const test = require('node:test');
const assert = require('node:assert');

const { productUrl, normalizeProduct, dedupeItems } = require('../../../../lib/competitors/niagara/normalize');
const page = require('./fixtures/products-bilstein-page1.json');

const options = { baseUrl: 'https://niagarajeeps.ca', maxPrice: 20000 };

test('productUrl is the handle page, with ?variant= only when the product has several variants', () => {
	assert.strictEqual(productUrl({ baseUrl: options.baseUrl, handle: 'bilstein-b6-kit', variantId: 9002, variantCount: 2 }), 'https://niagarajeeps.ca/products/bilstein-b6-kit?variant=9002');
	assert.strictEqual(productUrl({ baseUrl: options.baseUrl, handle: 'bilstein-5100', variantId: 9001, variantCount: 1 }), 'https://niagarajeeps.ca/products/bilstein-5100');
});

test('a single-variant product gives one item with price, sku and link', () => {
	const { items, invalid } = normalizeProduct(page.products[0], options);
	assert.deepStrictEqual(invalid, []);
	assert.deepStrictEqual(items, [{
		competitorSku: 'BIL-24-186728', price: 152.95, regularPrice: null, available: true,
		url: 'https://niagarajeeps.ca/products/bilstein-5100-shock-24-186728', productId: 101, variantId: 9001, vendor: 'BILSTEIN',
	}]);
});

test('each variant of a multi-variant product is its own item with its own link and price', () => {
	const { items } = normalizeProduct(page.products[1], options);
	assert.deepStrictEqual(items.map((i) => [i.competitorSku, i.price, i.regularPrice, i.available, i.url]), [
		['BIL-24-285643', 210, 250, true, 'https://niagarajeeps.ca/products/bilstein-b6-kit?variant=9002'],
		['BIL-24-285650', 198.5, null, false, 'https://niagarajeeps.ca/products/bilstein-b6-kit?variant=9003'],
	]);
});

test('price 0 and a missing sku are invalid with a reason, never items', () => {
	assert.deepStrictEqual(normalizeProduct(page.products[2], options).invalid.map((x) => x.reason), ['invalid-price']);
	assert.deepStrictEqual(normalizeProduct(page.products[3], options).invalid.map((x) => x.reason), ['no-sku']);
	assert.deepStrictEqual(normalizeProduct(page.products[2], options).items, []);
});

test('a price above maxPrice or not a number is invalid', () => {
	const product = { id: 1, handle: 'h', vendor: 'V', variants: [{ id: 1, sku: 'A-1', price: '25000.00' }, { id: 2, sku: 'A-2', price: 'abc' }] };
	assert.deepStrictEqual(normalizeProduct(product, options).invalid.map((x) => x.reason), ['invalid-price', 'invalid-price']);
});

test('a product without a handle is invalid: we cannot link it', () => {
	const product = { id: 1, handle: '', vendor: 'V', variants: [{ id: 1, sku: 'A-1', price: '5.00' }] };
	assert.deepStrictEqual(normalizeProduct(product, options).invalid.map((x) => x.reason), ['no-handle']);
});

test('dedupeItems keeps the cheaper copy of a repeated sku, whatever the case or spacing', () => {
	const a = { competitorSku: 'BIL-1', price: 20 };
	const b = { competitorSku: ' bil-1 ', price: 10 };
	const c = { competitorSku: 'BIL-2', price: 5 };
	const { items, duplicates } = dedupeItems([a, b, c]);
	assert.deepStrictEqual(items, [b, c]);
	assert.deepStrictEqual(duplicates, [a]);
});
