const test = require('node:test');
const assert = require('node:assert');

const { matchRows, summarizeByLineCode } = require('../../../../lib/feeds/grandwest/matchRows');

const row = (item, overrides = {}) => {
	const [lineCode, ...rest] = item.split('-');
	return { item, lineCode, part: rest.join('-'), cost: 10, stock: 1, stockText: '1', ...overrides };
};

const CATALOG = [
	{ sku: 'BDS-001401', searchable_sku: '001401', status: 1 },
	{ sku: 'CUR-11000', searchable_sku: '11000', status: 1 }, // Currie: must never get a CURT price
	{ sku: 'CMF-11000', searchable_sku: '11000', status: 1 }, // CURT
	{ sku: 'SB-2820', searchable_sku: '2820', status: 1 },
	{ sku: 'DEZ-DZ16203', searchable_sku: 'DZ16203', status: 1 },
	{ sku: 'PLC-001247R03', searchable_sku: '001247R03', status: 1 },
	{ sku: 'FAD-FOC-TG-7W96', searchable_sku: 'FOC-TG-7W96', status: 1 },
	{ sku: 'HOL-12-125', searchable_sku: '12-125', status: 1 },
];
const LINE_CODES = new Map([['BDS', 'BDS'], ['CUR', 'CMF'], ['SMT', 'SB'], ['DEE', 'DEZ'], ['PLA', 'PLC'], ['FOC', 'FAD'], ['HOL', 'HOL']]);

function loader(calls = []) {
	return async (prefix) => {
		calls.push(prefix);
		return CATALOG.filter((p) => p.sku.startsWith(`${prefix}-`));
	};
}

test('rows match our products through the line code map and the part rewrites', async () => {
	const rows = ['BDS-001401', 'CUR-11000', 'SMT-SB2820', 'DEE-16203', 'PLA-1247R03', 'FOC-TG7W96'].map((item) => row(item));

	const result = await matchRows(rows, { lineCodeToPrefix: LINE_CODES, loadProductsForPrefix: loader() });

	assert.deepStrictEqual(result.matched.map((m) => [m.item, m.productSku]), [
		['BDS-001401', 'BDS-001401'],
		['CUR-11000', 'CMF-11000'],
		['SMT-SB2820', 'SB-2820'],
		['DEE-16203', 'DEZ-DZ16203'],
		['PLA-1247R03', 'PLC-001247R03'],
		['FOC-TG7W96', 'FAD-FOC-TG-7W96'],
	]);
	assert.deepStrictEqual(result.unmatched, []);
});

test('a CURT item missing from our CURT products stays unmatched, never lands on Currie', async () => {
	const catalogWithoutCurt = async (prefix) => CATALOG.filter((p) => p.sku.startsWith(`${prefix}-`) && p.sku !== 'CMF-11000');

	const result = await matchRows([row('CUR-11000')], { lineCodeToPrefix: LINE_CODES, loadProductsForPrefix: catalogWithoutCurt });

	assert.deepStrictEqual(result.matched, []);
	assert.deepStrictEqual(result.unmatched, [{ item: 'CUR-11000', lineCode: 'CUR', prefix: 'CMF', part: '11000', reason: 'no-sku-match' }]);
});

test('a brand we do not carry is skipped without loading any products', async () => {
	const calls = [];

	const result = await matchRows([row('ACC-11269'), row('BDS-001401')], { lineCodeToPrefix: LINE_CODES, loadProductsForPrefix: loader(calls) });

	assert.deepStrictEqual(result.notCarried, [{ item: 'ACC-11269', lineCode: 'ACC', reason: 'brand-not-carried' }]);
	assert.deepStrictEqual(calls, ['BDS'], 'only prefixes present in the file are loaded');
	assert.strictEqual(result.matched.length, 1);
});

test('two Grandwest items on one product: only the exact one is written', async () => {
	const rows = [row('HOL-12-125'), row('HOL-121-25')];

	const result = await matchRows(rows, { lineCodeToPrefix: LINE_CODES, loadProductsForPrefix: loader() });

	assert.deepStrictEqual(result.matched.map((m) => m.item), ['HOL-12-125']);
	assert.deepStrictEqual(result.collisions, [{ item: 'HOL-121-25', lineCode: 'HOL', productSku: 'HOL-12-125', keptItem: 'HOL-12-125', reason: 'feed-collision' }]);
});

test('two inexact items on one product: neither is written', async () => {
	const rows = [row('HOL-12125'), row('HOL-121_25')];

	const result = await matchRows(rows, { lineCodeToPrefix: LINE_CODES, loadProductsForPrefix: loader() });

	assert.deepStrictEqual(result.matched, []);
	assert.deepStrictEqual(result.collisions.map((c) => [c.item, c.keptItem]), [['HOL-12125', null], ['HOL-121_25', null]]);
});

test('summarizeByLineCode counts matched and unmatched per mapped line code, largest first', async () => {
	const rows = [row('BDS-001401'), row('BDS-999'), row('BDS-998'), row('CUR-11000'), row('ACC-1')];
	const result = await matchRows(rows, { lineCodeToPrefix: LINE_CODES, loadProductsForPrefix: loader() });

	assert.deepStrictEqual(summarizeByLineCode(result), [
		{ lineCode: 'BDS', prefix: 'BDS', matched: 1, unmatched: 2, collisions: 0 },
		{ lineCode: 'CUR', prefix: 'CMF', matched: 1, unmatched: 0, collisions: 0 },
	]);
});
