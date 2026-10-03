const test = require('node:test');
const assert = require('node:assert');

const { getTdotConfig, DEFAULTS } = require('../../../../config/tdot');

const base = { SCRAPER_CONTACT_EMAIL: 'dev@example.com' };

test('config requires the contact e-mail and builds the User-Agent from it', () => {
	assert.throws(() => getTdotConfig({}), /SCRAPER_CONTACT_EMAIL/);
	const cfg = getTdotConfig(base);
	assert.strictEqual(cfg.userAgent, 'JustJeepsPriceMonitor/1.0 (+dev@example.com)');
	assert.strictEqual(cfg.contactEmail, 'dev@example.com');
});

test('config has safe defaults for the Klevu crawl', () => {
	const cfg = getTdotConfig(base);
	assert.strictEqual(cfg.storefrontUrl, 'https://www.tdotperformance.ca/');
	assert.strictEqual(cfg.klevuConfigBaseUrl, 'https://js.klevu.com/klevu-js-v1/klevu-js-api');
	assert.strictEqual(cfg.pageSize, 100);
	assert.strictEqual(cfg.requestDelayMs, 1000);
	assert.strictEqual(cfg.concurrency, 2);
	assert.strictEqual(cfg.timeoutMs, 30000);
	assert.strictEqual(cfg.maxPrice, 20000);
	assert.strictEqual(cfg.brandCrawlMaxItems, 10000);
	assert.strictEqual(cfg.maxRequests, 6000);
	assert.strictEqual(cfg.maxRunMinutes, 150);
	assert.strictEqual(cfg.labelLimit, 0, '0 = no dev cap');
	assert.strictEqual(cfg.fallbackApiKey, '');
	assert.strictEqual(cfg.fallbackSearchDomain, '');
	assert.deepStrictEqual(cfg.thresholds, DEFAULTS.thresholds);
});

test('config reads and clamps the env overrides', () => {
	const cfg = getTdotConfig({
		...base,
		TDOT_PAGE_SIZE: '500', TDOT_REQUEST_DELAY_MS: '-5', TDOT_CONCURRENCY: '9', TDOT_REQUEST_TIMEOUT_MS: '10',
		TDOT_MAX_PRICE: '50000', TDOT_BRAND_CRAWL_MAX_ITEMS: '2000', TDOT_MAX_REQUESTS: '100', TDOT_MAX_RUN_MINUTES: '5',
		TDOT_LABEL_LIMIT: '3', TDOT_KLEVU_API_KEY: ' klevu-123 ', TDOT_KLEVU_SEARCH_DOMAIN: 'uscs32.ksearchnet.com',
		TDOT_MIN_MATCHED: '42', TDOT_MAX_FAILED_REQUEST_RATIO: '0.3', TDOT_MAX_INVALID_RATIO: '0.5',
	});
	assert.strictEqual(cfg.pageSize, 100, 'the Klevu endpoint caps at 100');
	assert.strictEqual(cfg.requestDelayMs, 0);
	assert.strictEqual(cfg.concurrency, 4, 'max 4');
	assert.strictEqual(cfg.timeoutMs, 1000, 'min 1 s');
	assert.strictEqual(cfg.maxPrice, 50000);
	assert.strictEqual(cfg.brandCrawlMaxItems, 2000);
	assert.strictEqual(cfg.maxRequests, 100);
	assert.strictEqual(cfg.maxRunMinutes, 5);
	assert.strictEqual(cfg.labelLimit, 3);
	assert.strictEqual(cfg.fallbackApiKey, 'klevu-123');
	assert.strictEqual(cfg.fallbackSearchDomain, 'uscs32.ksearchnet.com');
	assert.strictEqual(cfg.thresholds.minMatched, 42);
	assert.strictEqual(cfg.thresholds.maxFailedRequestRatio, 0.3);
	assert.strictEqual(cfg.thresholds.maxInvalidRatio, 0.5);
});

test('the offline config (thresholds, timeout) needs no contact e-mail: snapshot runs make no Klevu request', () => {
	const { getTdotOfflineConfig } = require('../../../../config/tdot');
	const offline = getTdotOfflineConfig({ TDOT_MIN_MATCHED: '5', TDOT_REQUEST_TIMEOUT_MS: '5000' });
	assert.strictEqual(offline.thresholds.minMatched, 5);
	assert.strictEqual(offline.timeoutMs, 5000);
	assert.strictEqual(offline.userAgent, undefined);
});
