const test = require('node:test');
const assert = require('node:assert');

const grandwest = require('../../config/grandwest');
const vendorsPrefix = require('../../prisma/seeds/hard-code_data/vendors_prefix');

test('constants match the 2026-11-10 price list', () => {
	assert.strictEqual(grandwest.VENDOR_NAME, 'Grandwest');
	assert.strictEqual(grandwest.VENDOR_WEBSITE, 'https://www.grandwestauto.com');
	assert.strictEqual(grandwest.FEED_ID, 'grandwest');
	assert.strictEqual(grandwest.FILE_NAME, 'grandwest-price-list.csv');
	assert.deepStrictEqual(grandwest.EXPECTED_COLUMNS, ['Item', 'LineCode', 'Desciption', 'UnitPrice', 'ListPrice', 'Quantity', 'UPC']);
	assert.strictEqual(grandwest.MIN_SIZE_RATIO, 0.7);
	assert.strictEqual(grandwest.MAX_INVALID_RATIO, 0.02);
	assert.ok(Object.isFrozen(grandwest.EXPECTED_COLUMNS));
});

test('minMatched reads GRANDWEST_MIN_MATCHED and falls back on garbage', () => {
	const fallback = grandwest.MIN_MATCHED;
	assert.strictEqual(grandwest.minMatched({}), fallback);
	assert.strictEqual(grandwest.minMatched({ GRANDWEST_MIN_MATCHED: '900' }), 900);
	assert.strictEqual(grandwest.minMatched({ GRANDWEST_MIN_MATCHED: 'abc' }), fallback);
	assert.strictEqual(grandwest.minMatched({ GRANDWEST_MIN_MATCHED: '0' }), fallback, 'zero would disable the gate');
	assert.strictEqual(grandwest.minMatched({ GRANDWEST_MIN_MATCHED: '-5' }), fallback);
});

test('lineCodeToPrefix maps the 85 Grandwest codes from vendors_prefix', () => {
	const map = grandwest.lineCodeToPrefix(vendorsPrefix);
	assert.strictEqual(map.size, 85);
	assert.strictEqual(map.get('BDS'), 'BDS');
	assert.strictEqual(map.get('WET'), 'WTC');
	assert.strictEqual(map.get('FOC'), 'FAD');
});

test('a Grandwest code with our letters but another brand never maps to that prefix', () => {
	const map = grandwest.lineCodeToPrefix(vendorsPrefix);
	const traps = {
		CUR: 'CMF', // CURT, not Currie
		ARI: 'ARS', // Aries, not Artec
		ALP: 'ALR', // AlphaRex, not Alpine
		RAN: 'RNH', // Ranch Hand, not Rancho
		ARD: 'AID', // Air Design, not Armordillo
		TRI: 'TMX', // Trimax, not Trigger
		SPT: 'SPB', // Sprint Booster, not SpiderTrax
	};
	for (const [lineCode, prefix] of Object.entries(traps)) assert.strictEqual(map.get(lineCode), prefix, lineCode);
	for (const notCarried of ['ACC', 'EXC', 'RAM', 'COB', 'BED', 'AMP', 'TGG', 'PRO']) {
		assert.strictEqual(map.has(notCarried), false, notCarried);
	}
});

test('lineCodeToPrefix is case and space insensitive and refuses a code used twice', () => {
	const map = grandwest.lineCodeToPrefix([{ jj_prefix: 'AAA', grandwest_code: ' xyz ' }, { jj_prefix: 'BBB' }]);
	assert.deepStrictEqual([...map], [['XYZ', 'AAA']]);
	assert.throws(
		() => grandwest.lineCodeToPrefix([{ jj_prefix: 'AAA', grandwest_code: 'XYZ' }, { jj_prefix: 'BBB', grandwest_code: 'xyz' }]),
		/XYZ.*AAA.*BBB/,
	);
});

test('partNumberFor applies the per brand rewrite and leaves other codes alone', () => {
	const { partNumberFor } = grandwest;
	assert.strictEqual(partNumberFor('SMT', 'SB61468W'), '61468W');
	assert.strictEqual(partNumberFor('SMT', 'SB'), 'SB', 'never rewrite to an empty part number');
	assert.strictEqual(partNumberFor('DEE', '16318-16121'), 'DZ16318-16121');
	assert.strictEqual(partNumberFor('DEE', 'DZ4445JL'), 'DZ4445JL', 'no double DZ');
	assert.strictEqual(partNumberFor('PLA', '1247R03'), '001247R03');
	assert.strictEqual(partNumberFor('PLA', '8580'), '008580');
	assert.strictEqual(partNumberFor('PLA', '004266R01'), '004266R01');
	assert.strictEqual(partNumberFor('FOC', 'TG7W96'), 'FOCTG7W96');
	assert.strictEqual(partNumberFor('FOC', 'FOC-TG-7W96'), 'FOC-TG-7W96', 'no double FOC');
	assert.strictEqual(partNumberFor('BDS', '001401'), '001401');
});
