// Env -> config for a Shopify competitor scraper (DD-021, DD-022): the
// collector settings and the ingest guards, read from <PREFIX>_* variables
// (NIAGARA_MIN_ITEMS, MYTRUCKPOINT_MIN_ITEMS...). Each store passes its prefix
// and its own defaults. Pure: process.env and literals only, same rule as
// config/cron-jobs.js, so tests and verify scripts can load it.

const PAGE_SIZE_MAX = 250; // Shopify products.json limit
const MIN_REQUEST_DELAY_MS = 1000;
// page * limit may not pass 25,000 (verified 2026-11-02 and 2026-11-19), so 100 pages of 250.
const MAX_PAGES = 100;

function intFrom(value, fallback, min, max) {
	const n = Number(value);
	if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), min), max);
}

function ratioFrom(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

function createShopifyCompetitorConfig({ envPrefix, defaults }) {
	const name = (suffix) => `${envPrefix}_${suffix}`;

	function getOfflineConfig(env = process.env) {
		return {
			maxPrice: intFrom(env[name('MAX_PRICE')], defaults.maxPrice, 1, 1000000),
			snapshotMaxAgeHours: intFrom(env[name('SNAPSHOT_MAX_AGE_HOURS')], defaults.snapshotMaxAgeHours, 1, 24 * 30),
			thresholds: {
				minItems: intFrom(env[name('MIN_ITEMS')], defaults.minItems, 0, Number.MAX_SAFE_INTEGER),
				minMatched: intFrom(env[name('MIN_MATCHED')], defaults.minMatched, 1, Number.MAX_SAFE_INTEGER),
				maxFailedRequestRatio: ratioFrom(env[name('MAX_FAILED_REQUEST_RATIO')], defaults.maxFailedRequestRatio),
				maxBrandsFailedRatio: ratioFrom(env[name('MAX_BRANDS_FAILED_RATIO')], defaults.maxBrandsFailedRatio),
				maxInvalidRatio: ratioFrom(env[name('MAX_INVALID_RATIO')], defaults.maxInvalidRatio),
				matchDropRatio: ratioFrom(env[name('MATCH_DROP_RATIO')], defaults.matchDropRatio),
			},
		};
	}

	function getConfig(env = process.env) {
		const contactEmail = String(env.SCRAPER_CONTACT_EMAIL || '').trim();
		if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the scraper User-Agent');

		return {
			...getOfflineConfig(env),
			baseUrl: env[name('BASE_URL')] || defaults.baseUrl,
			pageSize: intFrom(env[name('PAGE_SIZE')], defaults.pageSize, 1, PAGE_SIZE_MAX),
			requestDelayMs: intFrom(env[name('REQUEST_DELAY_MS')], defaults.requestDelayMs, MIN_REQUEST_DELAY_MS, 60000),
			jitterMs: intFrom(env[name('JITTER_MS')], defaults.jitterMs, 0, 10000),
			timeoutMs: intFrom(env[name('REQUEST_TIMEOUT_MS')], defaults.timeoutMs, 1000, 120000),
			maxAttempts: intFrom(env[name('MAX_ATTEMPTS')], defaults.maxAttempts, 1, 10),
			backoffMs: intFrom(env[name('BACKOFF_MS')], defaults.backoffMs, 0, 60000),
			retryAfterCapMs: intFrom(env[name('RETRY_AFTER_CAP_MS')], defaults.retryAfterCapMs, 1000, 600000),
			challengeRetryDelayMs: intFrom(env[name('CHALLENGE_RETRY_DELAY_MS')], defaults.challengeRetryDelayMs, 0, 600000),
			consecutiveFailureLimit: intFrom(env[name('CONSECUTIVE_FAILURE_LIMIT')], defaults.consecutiveFailureLimit, 1, 100),
			maxRequests: intFrom(env[name('MAX_REQUESTS')], defaults.maxRequests, 1, 100000),
			maxRunMinutes: intFrom(env[name('MAX_RUN_MINUTES')], defaults.maxRunMinutes, 1, 600),
			maxPagesPerBrand: intFrom(env[name('MAX_PAGES_PER_BRAND')], defaults.maxPagesPerBrand, 1, MAX_PAGES),
			contactEmail,
			userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`,
		};
	}

	return { getConfig, getOfflineConfig };
}

module.exports = { createShopifyCompetitorConfig, intFrom, ratioFrom };
