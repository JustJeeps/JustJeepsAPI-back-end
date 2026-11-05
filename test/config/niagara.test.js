const test = require('node:test');
const assert = require('node:assert');

const { getNiagaraConfig, getNiagaraOfflineConfig, COMPETITOR } = require('../../config/niagara');

test('defaults follow DD-021 and the User-Agent carries the contact', () => {
	const c = getNiagaraConfig({ SCRAPER_CONTACT_EMAIL: 'ops@example.test' });
	assert.strictEqual(c.baseUrl, 'https://niagarajeeps.ca');
	assert.strictEqual(c.pageSize, 250);
	assert.strictEqual(c.requestDelayMs, 3000);
	assert.strictEqual(c.jitterMs, 1000);
	assert.strictEqual(c.maxPagesPerBrand, 100);
	assert.strictEqual(c.consecutiveFailureLimit, 5);
	assert.strictEqual(c.maxRequests, 1500);
	assert.strictEqual(c.maxRunMinutes, 120);
	assert.strictEqual(c.snapshotMaxAgeHours, 72);
	assert.strictEqual(getNiagaraOfflineConfig({}).snapshotMaxAgeHours, 72);
	assert.strictEqual(getNiagaraOfflineConfig({ NIAGARA_SNAPSHOT_MAX_AGE_HOURS: '0' }).snapshotMaxAgeHours, 1);
	assert.strictEqual(c.userAgent, 'JustJeepsPriceMonitor/1.0 (+ops@example.test)');
	assert.deepStrictEqual(c.thresholds, {
		minItems: 1000, minMatched: 200, maxFailedRequestRatio: 0.1, maxBrandsFailedRatio: 0.2, maxInvalidRatio: 0.02, matchDropRatio: 0.8,
	});
});

test('the competitor is fixed once: front-end and exports match this exact name', () => {
	assert.deepStrictEqual(COMPETITOR, { name: 'Niagara Jeeps', website: 'https://niagarajeeps.ca/' });
});

test('env overrides are parsed and clamped', () => {
	const c = getNiagaraConfig({
		SCRAPER_CONTACT_EMAIL: 'x@y.test', NIAGARA_PAGE_SIZE: '1000', NIAGARA_REQUEST_DELAY_MS: '100',
		NIAGARA_MIN_MATCHED: '4200', NIAGARA_MATCH_DROP_RATIO: '0.9', NIAGARA_MAX_REQUESTS: 'abc',
	});
	assert.strictEqual(c.pageSize, 250, 'Shopify caps products.json at 250');
	assert.strictEqual(c.requestDelayMs, 1000, 'never faster than one request a second');
	assert.strictEqual(c.thresholds.minMatched, 4200);
	assert.strictEqual(c.thresholds.matchDropRatio, 0.9);
	assert.strictEqual(c.maxRequests, 1500, 'garbage falls back to the default');
});

test('a missing contact e-mail is a startup error for a live run', () => {
	assert.throws(() => getNiagaraConfig({}), /SCRAPER_CONTACT_EMAIL/);
});

test('the offline config (snapshot ingest) needs no contact e-mail', () => {
	const c = getNiagaraOfflineConfig({ NIAGARA_MIN_MATCHED: '0' });
	assert.strictEqual(c.thresholds.minMatched, 1, 'never 0');
	assert.strictEqual(c.userAgent, undefined);
});
