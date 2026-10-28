const test = require('node:test');
const assert = require('node:assert');

const jrp = require('../../config/jrp');
const vendorsPrefix = require('../../prisma/seeds/hard-code_data/vendors_prefix');

const DEFAULT_PREFIXES = ['AFE', 'AIR', 'ALR', 'BIL', 'BOR', 'ESP', 'FLM', 'HOL', 'HU', 'KCH'];

test('constants match the 2026-10-27 discovery', () => {
	assert.strictEqual(jrp.VENDOR_NAME, 'JRP');
	assert.strictEqual(jrp.VENDOR_WEBSITE, 'https://www.jrpdatapoint.com');
	assert.strictEqual(jrp.FEED_ID, 'jrp-ftp');
	assert.strictEqual(jrp.REMOTE_FILE, 'JUSJEE.csv');
	assert.deepStrictEqual(jrp.EXPECTED_COLUMNS, ['BRAND', 'JRPSKU', 'OEMSKU', 'DESCRIPTION', 'IN-STOCK', 'COST', 'MAP']);
	assert.strictEqual(jrp.MIN_FILE_BYTES, 500_000);
	assert.strictEqual(jrp.MIN_SIZE_RATIO, 0.7);
	assert.strictEqual(jrp.MIN_MATCHED, 1500);
	assert.strictEqual(jrp.MAX_INVALID_RATIO, 0.02);
	assert.strictEqual(jrp.STOCK_PLUS_VALUE, 4);
	assert.ok(Object.isFrozen(jrp.EXPECTED_COLUMNS));
});

test('OEM_STRIP removes a leading AIR from Airaid part numbers only', () => {
	assert.deepStrictEqual(Object.keys(jrp.OEM_STRIP), ['AIR']);
	assert.strictEqual('AIR100-262'.replace(jrp.OEM_STRIP.AIR, ''), '100-262');
	assert.strictEqual('100-AIR'.replace(jrp.OEM_STRIP.AIR, ''), '100-AIR');
});

test('minMatched reads JRP_MIN_MATCHED and falls back on garbage', () => {
	assert.strictEqual(jrp.minMatched({}), 1500);
	assert.strictEqual(jrp.minMatched({ JRP_MIN_MATCHED: '900' }), 900);
	assert.strictEqual(jrp.minMatched({ JRP_MIN_MATCHED: 'abc' }), 1500);
	assert.strictEqual(jrp.minMatched({ JRP_MIN_MATCHED: '0' }), 1500, 'zero would disable the gate');
	assert.strictEqual(jrp.minMatched({ JRP_MIN_MATCHED: '-5' }), 1500);
});

test('activeBrands defaults to the 10 approved prefixes', () => {
	assert.deepStrictEqual([...jrp.activeBrands({})].sort(), DEFAULT_PREFIXES);
	assert.deepStrictEqual([...jrp.activeBrands({ JRP_ACTIVE_BRANDS: '  ' })].sort(), DEFAULT_PREFIXES);
});

test('activeBrands override is trimmed, upper-cased and drops empty entries', () => {
	assert.deepStrictEqual(jrp.activeBrands({ JRP_ACTIVE_BRANDS: ' alr, ,bil,,  hu ' }), ['ALR', 'BIL', 'HU']);
});

test('activeBrands returns a new array each call', () => {
	const first = jrp.activeBrands({});
	first.push('XXX');
	assert.ok(!jrp.activeBrands({}).includes('XXX'));
});

test('brandLabelToPrefix is case and whitespace insensitive and skips rows without jrp_code', () => {
	const rows = [
		{ jj_prefix: 'AFE', jrp_code: ' aFe Power ' },
		{ jj_prefix: 'KCH', jrp_code: 'KC HiLiTES', jrp_aliases: ['KC Lights', ' kc hilites inc '] },
		{ jj_prefix: 'XYZ', brand_name: 'No JRP' },
		{ jj_prefix: 'EMP', jrp_code: '   ' },
	];
	const map = jrp.brandLabelToPrefix(rows);
	assert.strictEqual(map.get('afe power'), 'AFE');
	assert.strictEqual(map.get('kc hilites'), 'KCH');
	assert.strictEqual(map.get('kc lights'), 'KCH');
	assert.strictEqual(map.get('kc hilites inc'), 'KCH');
	assert.strictEqual(map.size, 4);
	assert.deepStrictEqual(rows[0], { jj_prefix: 'AFE', jrp_code: ' aFe Power ' }, 'input is not mutated');
});

test('vendors_prefix maps every JRP feed label to its prefix', () => {
	const map = jrp.brandLabelToPrefix(vendorsPrefix);
	const feedLabels = {
		'aFe Power': 'AFE', Airaid: 'AIR', AlphaRex: 'ALR', Bilstein: 'BIL', 'Borla Performance': 'BOR',
		'Energy Suspension': 'ESP', Flowmaster: 'FLM', Holley: 'HOL', 'Husky Liners': 'HU', 'KC HiLiTES': 'KCH',
	};
	for (const [label, prefix] of Object.entries(feedLabels)) {
		assert.strictEqual(map.get(label.toLowerCase()), prefix, label);
	}
	assert.strictEqual(map.size, DEFAULT_PREFIXES.length);
	assert.deepStrictEqual([...map.values()].sort(), [...jrp.activeBrands({})].sort());
});
