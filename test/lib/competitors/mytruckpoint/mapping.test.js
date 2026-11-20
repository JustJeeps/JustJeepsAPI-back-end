// The real MyTruckPoint mapping in vendors_prefix.js (DD-022): every mapped
// brand has a usable collection handle and at least one SKU code, and no code
// or handle belongs to two of our brands, which would put one listing under
// two products.

const test = require('node:test');
const assert = require('node:assert');

const vendorsPrefix = require('../../../../prisma/seeds/hard-code_data/vendors_prefix');
const { createBrandReader } = require('../../../../lib/competitors/shopify/brands');
const { MYTRUCKPOINT_PROFILE } = require('../../../../lib/competitors/mytruckpoint/profile');

const brands = createBrandReader(MYTRUCKPOINT_PROFILE).readBrands(vendorsPrefix);

test('the mapping covers the brands found by the discovery of 2026-11-19', () => {
	assert.ok(brands.length >= 74, `only ${brands.length} brands mapped`);
});

test('every mapped brand has a Shopify handle and at least one 4-letter SKU code', () => {
	for (const b of brands) {
		assert.match(b.handle, /^[a-z0-9_-]+$/, `${b.jjPrefix} handle ${b.handle}`);
		assert.ok(b.skuPrefixes.length > 0, `${b.jjPrefix} has no SKU code`);
		for (const p of b.skuPrefixes) assert.match(p, /^[A-Z]{4}_$/, `${b.jjPrefix} code ${p}`);
	}
});

test('no SKU code, handle or jj_prefix is mapped twice', () => {
	const seen = (values) => values.filter((v, i) => values.indexOf(v) !== i);
	assert.deepStrictEqual(seen(brands.flatMap((b) => b.skuPrefixes)), []);
	assert.deepStrictEqual(seen(brands.map((b) => b.handle)), []);
	assert.deepStrictEqual(seen(brands.map((b) => b.jjPrefix)), []);
});
