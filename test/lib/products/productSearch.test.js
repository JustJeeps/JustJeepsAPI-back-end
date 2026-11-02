const test = require('node:test');
const assert = require('node:assert');

const { buildProductSearchWhere } = require('../../../lib/products/productSearch');

test('no search term means no filter', () => {
	assert.deepStrictEqual(buildProductSearchWhere(''), {});
	assert.deepStrictEqual(buildProductSearchWhere('   '), {});
	assert.deepStrictEqual(buildProductSearchWhere(undefined), {});
});

test('searches the product fields and every vendor SKU', () => {
	// A purchaser often has only the vendor's code (JRP's "BIL33-292984" for
	// our "BIL-33-292984"); before 2026-11-02 that found nothing at all.
	const where = buildProductSearchWhere(' BIL33-292984 ');
	const term = { contains: 'BIL33-292984', mode: 'insensitive' };

	assert.deepStrictEqual(where, {
		OR: [
			{ sku: term },
			{ name: term },
			{ brand_name: term },
			{ searchable_sku: term },
			{ vendorProducts: { some: { vendor_sku: term } } },
		],
	});
});
