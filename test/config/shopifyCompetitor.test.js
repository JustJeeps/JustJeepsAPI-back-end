const test = require('node:test');
const assert = require('node:assert');

const { createShopifyCompetitorConfig } = require('../../config/shopifyCompetitor');
const { DEFAULTS } = require('../../config/niagara');

const reader = createShopifyCompetitorConfig({ envPrefix: 'SHOPX', defaults: { ...DEFAULTS, baseUrl: 'https://shopx.test' } });
const contact = { SCRAPER_CONTACT_EMAIL: 'ops@example.com' };

test('a store reads only its own prefix', () => {
	const config = reader.getConfig({ ...contact, SHOPX_MIN_ITEMS: '5', NIAGARA_MIN_ITEMS: '9', SHOPX_REQUEST_TIMEOUT_MS: '5000' });
	assert.strictEqual(config.thresholds.minItems, 5);
	assert.strictEqual(config.timeoutMs, 5000);
	assert.strictEqual(config.baseUrl, 'https://shopx.test');
});

test('clamps hold for any prefix: delay floor, page cap and a bad ratio', () => {
	const config = reader.getConfig({ ...contact, SHOPX_REQUEST_DELAY_MS: '10', SHOPX_MAX_PAGES_PER_BRAND: '500', SHOPX_MATCH_DROP_RATIO: '3' });
	assert.strictEqual(config.requestDelayMs, 1000);
	assert.strictEqual(config.maxPagesPerBrand, 100);
	assert.strictEqual(config.thresholds.matchDropRatio, DEFAULTS.matchDropRatio);
});

test('a live config needs the contact e-mail, an offline one does not', () => {
	assert.throws(() => reader.getConfig({}), /SCRAPER_CONTACT_EMAIL is required/);
	assert.strictEqual(reader.getOfflineConfig({ SHOPX_MAX_PRICE: '50' }).maxPrice, 50);
});
