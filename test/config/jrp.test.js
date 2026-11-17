const test = require('node:test');
const assert = require('node:assert');

const jrp = require('../../config/jrp');
const vendorsPrefix = require('../../prisma/seeds/hard-code_data/vendors_prefix');

const DEFAULT_PREFIXES = [
	'AEM', 'AFE', 'AIR', 'ALR', 'ATM', 'BAE', 'BFG', 'BIL', 'BOR', 'COR',
	'DEI', 'ELE', 'ESP', 'FLM', 'HOL', 'HU', 'INJ', 'JBA', 'KCH', 'MGF',
];

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

test('activeBrands defaults to the 20 approved prefixes', () => {
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
		// Labels JRP added to the FTP file on 2026-11-11.
		'MagnaFlow Exhaust Products': 'MGF', 'Auto Meter Products': 'ATM', 'Baer Brakes': 'BAE', Corsa: 'COR',
		BFGoodrich: 'BFG', 'DEI - Design Engineering': 'DEI', 'JBA Performance Exhaust': 'JBA',
		'AEM Induction': 'AEM', 'AEM Electronics': 'AEM', 'INJEN Technology': 'INJ', 'Element Fire': 'ELE',
	};
	for (const [label, prefix] of Object.entries(feedLabels)) {
		assert.strictEqual(map.get(label.toLowerCase()), prefix, label);
	}
	assert.strictEqual(map.size, Object.keys(feedLabels).length);
	assert.deepStrictEqual([...new Set(map.values())].sort(), [...jrp.activeBrands({})].sort());
});

test('JRP labels that are a different company or would collide stay unmapped', () => {
	const map = jrp.brandLabelToPrefix(vendorsPrefix);
	// JRP's Artec makes turbo manifolds; our ARI is Artec Industries (Jeep armor).
	assert.strictEqual(map.get('artec'), undefined);
	// Holley EFI shares Holley's part numbers: mapping it would collide with the Holley rows.
	assert.strictEqual(map.get('holley efi'), undefined);
	assert.strictEqual(map.get('holley intech'), undefined);
});
