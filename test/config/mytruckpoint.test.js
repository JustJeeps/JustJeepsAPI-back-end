const test = require('node:test');
const assert = require('node:assert');

const { getMytruckpointConfig, getMytruckpointOfflineConfig, COMPETITOR, DEFAULTS } = require('../../config/mytruckpoint');
const { MYTRUCKPOINT_PROFILE } = require('../../lib/competitors/mytruckpoint/profile');

const contact = { SCRAPER_CONTACT_EMAIL: 'ops@example.com' };

test('MyTruckPoint defaults: the store URL, polite pacing and a budget for about 900 requests', () => {
	const config = getMytruckpointConfig(contact);
	assert.strictEqual(config.baseUrl, 'https://www.mytruckpoint.ca');
	assert.strictEqual(config.pageSize, 250);
	assert.strictEqual(config.requestDelayMs, 3000);
	assert.strictEqual(config.jitterMs, 1000);
	assert.strictEqual(config.maxRequests, 1600);
	assert.strictEqual(config.maxRunMinutes, 120);
	assert.strictEqual(config.maxPagesPerBrand, 100);
	assert.strictEqual(config.thresholds.minItems, 20000);
	assert.strictEqual(config.thresholds.minMatched, 1000);
	assert.strictEqual(config.userAgent, 'JustJeepsPriceMonitor/1.0 (+ops@example.com)');
});

test('MyTruckPoint reads MYTRUCKPOINT_* only, never another store prefix', () => {
	const config = getMytruckpointConfig({ ...contact, MYTRUCKPOINT_MIN_MATCHED: '5000', NIAGARA_MIN_MATCHED: '7' });
	assert.strictEqual(config.thresholds.minMatched, 5000);
	assert.strictEqual(getMytruckpointOfflineConfig({ MYTRUCKPOINT_MAX_PRICE: '900' }).maxPrice, 900);
	assert.throws(() => getMytruckpointConfig({}), /SCRAPER_CONTACT_EMAIL is required/);
	assert.ok(Object.isFrozen(DEFAULTS));
});

test('the MyTruckPoint profile: its own competitor, codes, fields, sku-code purity, twins, gzip and a 40-page index', () => {
	assert.deepStrictEqual(COMPETITOR, { name: 'MyTruckPoint', website: 'https://www.mytruckpoint.ca/' });
	assert.deepStrictEqual(MYTRUCKPOINT_PROFILE.competitor, COMPETITOR);
	assert.strictEqual(MYTRUCKPOINT_PROFILE.key, 'mytruckpoint');
	assert.strictEqual(MYTRUCKPOINT_PROFILE.command, 'seed-mytruckpoint');
	assert.strictEqual(MYTRUCKPOINT_PROFILE.code('BUSY'), 'MYTRUCKPOINT_BUSY');
	assert.strictEqual(MYTRUCKPOINT_PROFILE.tag, '[mytruckpoint]');
	assert.deepStrictEqual(MYTRUCKPOINT_PROFILE.mapping, { handleField: 'mytruckpoint_code', prefixesField: 'mytruckpoint_sku_prefixes' });
	assert.strictEqual(MYTRUCKPOINT_PROFILE.purity, 'sku-code');
	assert.strictEqual(MYTRUCKPOINT_PROFILE.preferAvailable, true);
	assert.strictEqual(MYTRUCKPOINT_PROFILE.gzipSnapshots, true);
	assert.strictEqual(MYTRUCKPOINT_PROFILE.maxIndexPages, 40);
	assert.strictEqual(MYTRUCKPOINT_PROFILE.brandPagePath, null);
});
