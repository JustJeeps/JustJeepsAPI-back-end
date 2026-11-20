const test = require('node:test');
const assert = require('node:assert');

const { nameCandidates, measureSample, classify, decideAll, proposalLines } = require('../../../../lib/competitors/mytruckpoint/discovery');

const rows = [
	{ jj_prefix: 'BIL', brand_name: 'Bilstein' },
	{ jj_prefix: 'RC', brand_name: 'Rough Country' },
	{ jj_prefix: 'OA', brand_name: 'OMIX-ADA' },
	{ jj_prefix: 'BXT', brand_name: 'Baxter Performance' },
	{ jj_prefix: 'TR', brand_name: 'T-Rex' },
	{ jj_prefix: 'PCT', brand_name: 'Pro Comp Tires' },
	{ jj_prefix: 'PCT', brand_name: 'Pro Comp Tire' },
	{ jj_prefix: '', brand_name: '' },
];
const collections = [
	{ handle: 'bilstein', title: 'Bilstein', products_count: 4241 },
	{ handle: 'rough-country-canada', title: 'Rough Country Lift Kits & Suspension Canada', products_count: 6115 },
	{ handle: 'omix', title: 'Omix', products_count: 5924 },
	{ handle: 'performance', title: 'Performance', products_count: 46547 },
	{ handle: 't-rex', title: 'T-Rex', products_count: 0 },
	{ handle: 'pro-comp-tires', title: 'Pro Comp Tires', products_count: 51 },
];
const product = (sku, vendor = 'X') => ({ id: sku, vendor, variants: [{ sku }] });

test('name candidates: exact title, decorated title, short store title; generic words and empty collections never match', () => {
	const found = nameCandidates(collections, rows).map((c) => [c.jjPrefix, c.handle, c.tier]);
	assert.deepStrictEqual(found, [
		['BIL', 'bilstein', 'exact'],
		['RC', 'rough-country-canada', 'loose'],
		['OA', 'omix', 'loose'],
		['PCT', 'pro-comp-tires', 'exact'],
	]);
});

test('measureSample lists the codes, their shares and vendor names, and the dominant vendor share', () => {
	const m = measureSample([product('BCSQ_1', 'WARN IND.'), product('BCSQ_2', 'Warn'), product('BCSQ_3', 'Warn'), product('plain', 'Warn')]);
	assert.deepStrictEqual(m.codes, [{ code: 'BCSQ_', count: 3, share: 1, vendor: 'WARN' }]);
	assert.strictEqual(m.codedShare, 0.75);
	assert.strictEqual(m.vendor, 'WARN');
	assert.strictEqual(m.vendorShare, 0.75);
	assert.strictEqual(m.products, 4);
	assert.deepStrictEqual(m.uncodedSamples, ['plain']);
});

const many = (code, n, vendor) => Array.from({ length: n }, (_, i) => product(`${code}${i}`, vendor));

test('classify proposes every code with 2% or more, so a brand sold under two distributor codes keeps both', () => {
	const camco = measureSample([...many('BBJF_', 70, 'Camco'), ...many('CFTT_', 29, 'CAMCO'), ...many('ZZZZ_', 1, 'CAMCO')]);
	const decision = classify({ tier: 'exact', productsCount: 900 }, camco);
	assert.strictEqual(decision.status, 'auto');
	assert.deepStrictEqual(decision.prefixes, ['BBJF_', 'CFTT_']);
});

test('classify: review for loose names, thin coding or codes under different vendor names; rejected for a category; flagged over the cap', () => {
	const single = measureSample(many('BBGL_', 4, 'Bilstein'));
	const thin = measureSample([product('BBGL_1', 'Bilstein'), product('a', 'Bilstein'), product('b', 'Bilstein')]);
	const icon = measureSample([...many('FRDH_', 7, 'ICON'), ...many('FRDK_', 3, 'ICON Vehicle Dynamics')]);
	const category = measureSample([...many('AAAA_', 3, 'Dorman'), ...many('BBBB_', 3, 'Hella'), ...many('CCCC_', 4, 'Moog')]);
	assert.strictEqual(classify({ tier: 'exact', productsCount: 10 }, single).status, 'auto');
	assert.strictEqual(classify({ tier: 'loose', productsCount: 10 }, single).status, 'review');
	assert.strictEqual(classify({ tier: 'exact', productsCount: 10 }, thin).status, 'review');
	assert.match(classify({ tier: 'exact', productsCount: 10 }, icon).reason, /different vendor names/);
	assert.strictEqual(classify({ tier: 'exact', productsCount: 10 }, category).status, 'rejected');
	assert.strictEqual(classify({ tier: 'exact', productsCount: 90000 }, category).status, 'rejected');
	assert.strictEqual(classify({ tier: 'exact', productsCount: 30000 }, single).status, 'flagged');
	assert.strictEqual(classify({ tier: 'exact', productsCount: 10 }, measureSample([])).status, 'rejected');
	assert.strictEqual(classify({ tier: 'exact', productsCount: 10 }, measureSample([product('plain', 'X')])).status, 'rejected');
});

test('a code measured on two exact brands of ours sends both to review and says why', () => {
	const decisions = decideAll([
		{ jjPrefix: 'OA', brandName: 'OMIX-ADA', handle: 'omix', tier: 'exact', productsCount: 9 },
		{ jjPrefix: 'RR', brandName: 'Rugged Ridge', handle: 'rugged', tier: 'exact', productsCount: 9 },
		{ jjPrefix: 'BIL', brandName: 'Bilstein', handle: 'bilstein', tier: 'exact', productsCount: 9 },
	], { omix: measureSample([product('BKGF_1', 'Omix')]), rugged: measureSample([product('BKGF_2', 'Omix')]), bilstein: measureSample([product('BBGL_1', 'Bilstein')]) });
	assert.deepStrictEqual(decisions.map((d) => [d.jjPrefix, d.status]), [['OA', 'review'], ['RR', 'review'], ['BIL', 'auto']]);
	assert.match(decisions[0].reason, /code BKGF_ also measured on RR/);
	assert.match(decisions[1].reason, /code BKGF_ also measured on OA/);
});

test('a loose name sharing an exact brand code goes to review and never demotes the exact brand', () => {
	const decisions = decideAll([
		{ jjPrefix: 'HEL', brandName: 'HELLA', handle: 'hella', tier: 'exact', productsCount: 9 },
		{ jjPrefix: 'EGR', brandName: 'EGR', handle: 'egr-and-related-components', tier: 'loose', productsCount: 9 },
	], { hella: measureSample([product('BFDP_1', 'HELLA')]), 'egr-and-related-components': measureSample([product('BFDP_2', 'HELLA')]) });
	assert.deepStrictEqual(decisions.map((d) => [d.jjPrefix, d.status]), [['HEL', 'auto'], ['EGR', 'review']]);
	assert.match(decisions[1].reason, /code BFDP_ also measured on HEL/);
});

test('proposal lines give the two vendors_prefix fields of each auto brand', () => {
	const lines = proposalLines([
		{ jjPrefix: 'BIL', handle: 'bilstein', prefixes: ['BBGL_'], status: 'auto' },
		{ jjPrefix: 'CAM', handle: 'camco', prefixes: ['BBJF_', 'CFTT_'], status: 'auto' },
		{ jjPrefix: 'RC', handle: 'x', prefixes: ['DHTP_'], status: 'review' },
	]);
	assert.deepStrictEqual(lines, [
		'BIL: mytruckpoint_code: "bilstein", mytruckpoint_sku_prefixes: ["BBGL_"]',
		'CAM: mytruckpoint_code: "camco", mytruckpoint_sku_prefixes: ["BBJF_", "CFTT_"]',
	]);
});
