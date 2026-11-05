const test = require('node:test');
const assert = require('node:assert');

const vendorsPrefix = require('../../../../prisma/seeds/hard-code_data/vendors_prefix');
const { niagaraBrands, filterBrands } = require('../../../../lib/competitors/niagara/brands');

const rows = [
	{ jj_prefix: 'BIL', brand_name: 'Bilstein', niagara_code: 'bilstein', niagara_sku_prefixes: ['BIL-'] },
	{ jj_prefix: 'RR', brand_name: 'Rugged Ridge', niagara_code: ' Rugged-Ridge ' },
	{ jj_prefix: 'AFE', brand_name: 'aFe Power', jrp_code: 'aFe Power' },
	{ jj_prefix: '', brand_name: '', niagara_code: 'orphan' },
];

test('niagaraBrands keeps only rows with a niagara_code and a jj_prefix, normalising handle and prefixes', () => {
	assert.deepStrictEqual(niagaraBrands(rows), [
		{ jjPrefix: 'BIL', brandName: 'Bilstein', handle: 'bilstein', skuPrefixes: ['BIL-'] },
		{ jjPrefix: 'RR', brandName: 'Rugged Ridge', handle: 'rugged-ridge', skuPrefixes: [] },
	]);
});

test('filterBrands narrows to the jj_prefixes asked for, case-insensitive; none asked means all', () => {
	const brands = niagaraBrands(rows);
	assert.deepStrictEqual(filterBrands(brands, ['bil']).map((b) => b.jjPrefix), ['BIL']);
	assert.strictEqual(filterBrands(brands, []).length, 2);
	assert.throws(() => filterBrands(brands, ['XYZ']), /XYZ/);
});

test('the real vendors_prefix.js mapping is consistent', () => {
	const brands = niagaraBrands(vendorsPrefix);
	assert.ok(brands.length >= 100, `expected the approved mapping, got ${brands.length} brands`);
	const handles = brands.map((b) => b.handle);
	assert.strictEqual(new Set(handles).size, handles.length, 'a collection handle is mapped twice');
	const prefixes = brands.map((b) => b.jjPrefix);
	assert.strictEqual(new Set(prefixes).size, prefixes.length, 'a jj_prefix is mapped twice');
	for (const brand of brands) {
		assert.match(brand.handle, /^[a-z0-9-]+$/, `bad handle for ${brand.jjPrefix}`);
		for (const p of brand.skuPrefixes) assert.match(p, /^[A-Z0-9&]+-?$/, `bad sku prefix ${p} for ${brand.jjPrefix}`);
	}
});
