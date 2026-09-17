const test = require('node:test');
const assert = require('node:assert');

const { getLowridersConfig } = require('../../config/lowriders');

test('defaults match DD-018 and the User-Agent carries the contact', () => {
	const c = getLowridersConfig({ SCRAPER_CONTACT_EMAIL: 'ops@example.test' });
	assert.strictEqual(c.brandId, 90296);
	assert.strictEqual(c.pageSize, 500);
	assert.strictEqual(c.pageDelayMs, 750);
	assert.strictEqual(c.timeoutMs, 30000);
	assert.strictEqual(c.maxPrice, 20000);
	assert.strictEqual(c.apiBaseUrl, 'https://api.sunhammer.io');
	assert.match(c.brandPageUrl, /^https:\/\/www\.lowriders\.ca\/b-90296-rough-country\.html/);
	assert.strictEqual(c.userAgent, 'JustJeepsPriceMonitor/1.0 (+ops@example.test)');
	assert.strictEqual(c.thresholds.minMatched, 500);
	assert.strictEqual(c.fallbackApiKey, '');
});

test('env overrides are parsed and clamped', () => {
	const c = getLowridersConfig({
		SCRAPER_CONTACT_EMAIL: 'x@y.test', LOWRIDERS_PAGE_SIZE: '5000', LOWRIDERS_MIN_MATCHED: '1200',
		LOWRIDERS_MIN_COLLECT_RATIO: '0.95', LOWRIDERS_PARTSLOGIC_API_KEY: 'k', LOWRIDERS_PAGE_DELAY_MS: 'abc',
	});
	assert.strictEqual(c.pageSize, 1000, 'API max verified at 1000');
	assert.strictEqual(c.thresholds.minMatched, 1200);
	assert.strictEqual(c.thresholds.minCollectRatio, 0.95);
	assert.strictEqual(c.fallbackApiKey, 'k');
	assert.strictEqual(c.pageDelayMs, 750, 'garbage falls back to the default');
});

test('missing contact e-mail is a startup error', () => {
	assert.throws(() => getLowridersConfig({}), /SCRAPER_CONTACT_EMAIL/);
});
