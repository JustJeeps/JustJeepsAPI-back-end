const test = require('node:test');
const assert = require('node:assert');

const { matchRows } = require('../../../../lib/feeds/jrp/matchRows');
const { brandLabelToPrefix, OEM_STRIP } = require('../../../../config/jrp');

const VENDORS_PREFIX = [
	{ jj_prefix: 'ALR', jrp_code: 'AlphaRex' },
	{ jj_prefix: 'AIR', jrp_code: 'Airaid' },
	{ jj_prefix: 'ESP', jrp_code: 'Energy Suspension' },
	{ jj_prefix: 'KCH', jrp_code: 'KC HiLiTES', jrp_aliases: ['KC Lights'] },
	{ jj_prefix: 'BIL', jrp_code: 'Bilstein' },
];

const CATALOG = {
	ALR: [{ sku: 'ALR-210081', searchable_sku: '210081', status: 1 }],
	AIR: [{ sku: 'AIR-100-262', searchable_sku: '100-262', status: 1 }],
	ESP: [{ sku: 'ESP-3.1108G', searchable_sku: '3.1108G', status: 1 }],
	KCH: [
		{ sku: 'KCH-0100-OLD', searchable_sku: '0100', status: 0 },
		{ sku: 'KCH-0100', searchable_sku: '0100', status: 1 },
	],
	BIL: [],
};

const row = (brandLabel, jrpSku, oemSku) => ({
	brandLabel, jrpSku, oemSku, description: '', stock: 1, stockText: '1', cost: 10, map: 12, mapBelowCost: false,
});

function setup({ active = ['ALR', 'AIR', 'ESP', 'KCH'] } = {}) {
	const calls = [];
	const loadProductsForPrefix = async (prefix) => {
		calls.push(prefix);
		return CATALOG[prefix] || [];
	};
	const options = {
		labelToPrefix: brandLabelToPrefix(VENDORS_PREFIX),
		activePrefixes: active,
		oemStrip: OEM_STRIP,
		loadProductsForPrefix,
	};
	return { calls, options };
}

test('brand labels match case and whitespace insensitively, aliases included', async () => {
	const { options } = setup();
	const result = await matchRows([
		row(' alpharex ', 'ARX210081', '210081'),
		row('KC LIGHTS', 'KCH0100', '0100'),
	], options);
	assert.deepStrictEqual(result.matched.map((m) => [m.jrpSku, m.productSku, m.prefix]), [
		['ARX210081', 'ALR-210081', 'ALR'],
		['KCH0100', 'KCH-0100', 'KCH'],
	]);
	assert.deepStrictEqual(result.unmatched, []);
});

test('the Airaid OEMSKU has its leading AIR stripped before matching', async () => {
	const { options } = setup();
	const result = await matchRows([row('Airaid', 'AIR100-262', 'AIR100-262')], options);
	assert.strictEqual(result.matched.length, 1);
	assert.strictEqual(result.matched[0].productSku, 'AIR-100-262');
	assert.strictEqual(result.matched[0].oemSku, 'AIR100-262', 'the feed value is kept on the row');
});

test('dots are kept: an Energy Suspension part with a dot matches only with the dot', async () => {
	const { options } = setup();
	const result = await matchRows([row('Energy Suspension', '3.1108G', '3.1108G'), row('Energy Suspension', '31108G', '31108G')], options);
	assert.deepStrictEqual(result.matched.map((m) => m.productSku), ['ESP-3.1108G']);
	assert.deepStrictEqual(result.unmatched.map((u) => [u.jrpSku, u.reason]), [['31108G', 'no-sku-match']]);
});

test('matching never uses JRPSKU', async () => {
	const { options } = setup();
	const result = await matchRows([row('AlphaRex', '210081', 'ZZZ999')], options);
	assert.strictEqual(result.matched.length, 0);
	assert.strictEqual(result.unmatched[0].reason, 'no-sku-match');
});

test('an inactive brand is skipped without loading its products', async () => {
	const { options, calls } = setup({ active: ['ALR'] });
	const result = await matchRows([row('Bilstein', 'BIL10-255605', '10-255605'), row('AlphaRex', 'ARX210081', '210081')], options);
	assert.deepStrictEqual(result.inactive, [{ brandLabel: 'Bilstein', jrpSku: 'BIL10-255605', oemSku: '10-255605', prefix: 'BIL', reason: 'skipped-inactive' }]);
	assert.deepStrictEqual(calls, ['ALR']);
	assert.strictEqual(result.matched.length, 1);
});

test('an unmapped brand is reported as no-brand-mapping', async () => {
	const { options } = setup();
	const result = await matchRows([row('Rugged Ridge', 'RUG1', '11585.01')], options);
	assert.deepStrictEqual(result.unmatched, [{ brandLabel: 'Rugged Ridge', jrpSku: 'RUG1', oemSku: '11585.01', reason: 'no-brand-mapping' }]);
});

test('an ambiguous match counts as matched and uses the tie-break (active product wins)', async () => {
	const { options } = setup();
	const result = await matchRows([row('KC HiLiTES', 'KCH0100', '0100')], options);
	assert.strictEqual(result.matched.length, 1);
	assert.strictEqual(result.matched[0].productSku, 'KCH-0100');
	assert.strictEqual(result.matched[0].ambiguous, true);
	assert.strictEqual(result.ambiguousCount, 1);
	assert.strictEqual(result.ambiguous.length, 1);
	const [listed] = result.ambiguous;
	assert.deepStrictEqual(
		{ brandLabel: listed.brandLabel, jrpSku: listed.jrpSku, oemSku: listed.oemSku, productSku: listed.productSku },
		{ brandLabel: 'KC HiLiTES', jrpSku: 'KCH0100', oemSku: '0100', productSku: 'KCH-0100' },
	);
	assert.deepStrictEqual(listed.otherCandidates, ['KCH-0100-OLD'], 'names the candidate that lost the tie-break');
});

test('products are loaded once per prefix, however many rows share it', async () => {
	const { options, calls } = setup();
	await matchRows([row('AlphaRex', 'A', '1'), row('AlphaRex', 'B', '2'), row('Airaid', 'C', 'AIR3')], options);
	assert.deepStrictEqual([...calls].sort(), ['AIR', 'ALR']);
});

test('the input rows are not mutated', async () => {
	const { options } = setup();
	const input = Object.freeze([Object.freeze(row('Airaid', 'AIR100-262', 'AIR100-262'))]);
	await matchRows(input, options);
	assert.strictEqual(input[0].oemSku, 'AIR100-262');
});

test('two feed rows that match the same product: the exact OEMSKU wins, the other is a feed collision', async () => {
	const { options } = setup();
	const result = await matchRows([row('AlphaRex', 'ARX2100-81', '2100-81'), row('AlphaRex', 'ARX210081', '210081')], options);
	assert.deepStrictEqual(result.matched.map((m) => m.jrpSku), ['ARX210081']);
	assert.deepStrictEqual(result.collisions, [{
		brandLabel: 'AlphaRex', jrpSku: 'ARX2100-81', oemSku: '2100-81', productSku: 'ALR-210081', keptJrpSku: 'ARX210081', reason: 'feed-collision',
	}]);
	assert.strictEqual(result.collisionCount, 1);
});

test('a feed collision with no exact OEMSKU keeps the smallest JRPSKU', async () => {
	const { options } = setup();
	const result = await matchRows([row('AlphaRex', 'ARXB', '2100-81'), row('AlphaRex', 'ARXA', '21-0081')], options);
	assert.deepStrictEqual(result.matched.map((m) => m.jrpSku), ['ARXA']);
	assert.deepStrictEqual(result.collisions.map((c) => [c.jrpSku, c.keptJrpSku]), [['ARXB', 'ARXA']]);
});

test('the Airaid strip counts as exact for the collision tie-break', async () => {
	const { options } = setup();
	const result = await matchRows([row('Airaid', 'AIR100262', 'AIR100262'), row('Airaid', 'AIR100-262', 'AIR100-262')], options);
	assert.deepStrictEqual(result.matched.map((m) => m.jrpSku), ['AIR100-262']);
	assert.strictEqual(result.collisionCount, 1);
});
