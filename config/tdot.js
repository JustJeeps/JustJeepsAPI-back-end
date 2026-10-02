// TDOT competitor prices (DD-019): env -> config for the Klevu collector and
// the run gates. Pure: process.env and literals only, same rule as
// config/lowriders.js, so tests and verify scripts can load it.

const DEFAULTS = Object.freeze({
	storefrontUrl: 'https://www.tdotperformance.ca/',
	klevuConfigBaseUrl: 'https://js.klevu.com/klevu-js-v1/klevu-js-api',
	pageSize: 100, // the Klevu endpoint caps noOfResults at 100 (verified 2026-10-02)
	requestDelayMs: 1000,
	concurrency: 2,
	timeoutMs: 30000,
	maxPrice: 20000,
	brandCrawlMaxItems: 10000, // above this a label is queried per product instead of crawled
	perProductResults: 20, // records asked per product query; the exact part ranks first
	consecutiveFailureLimit: 10, // circuit breaker: abort after this many failed requests in a row
	maxRequests: 6000,
	maxRunMinutes: 150,
	labelLimit: 0,
	thresholds: Object.freeze({
		minMatched: 200,
		maxFailedRequestRatio: 0.1,
		maxInvalidRatio: 0.02,
	}),
});

const PAGE_SIZE_MAX = 100;

function intFrom(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), min), max);
}

function ratioFrom(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

// The part of the config that needs no network identity: the canary
// thresholds and the HTTP timeout. Snapshot ingests and the ParseHub escape
// hatch use only this, so they run without SCRAPER_CONTACT_EMAIL.
function getTdotOfflineConfig(env = process.env) {
	return {
		timeoutMs: intFrom(env.TDOT_REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs, 1000, 120000),
		thresholds: {
			minMatched: intFrom(env.TDOT_MIN_MATCHED, DEFAULTS.thresholds.minMatched, 1, Number.MAX_SAFE_INTEGER),
			maxFailedRequestRatio: ratioFrom(env.TDOT_MAX_FAILED_REQUEST_RATIO, DEFAULTS.thresholds.maxFailedRequestRatio),
			maxInvalidRatio: ratioFrom(env.TDOT_MAX_INVALID_RATIO, DEFAULTS.thresholds.maxInvalidRatio),
		},
	};
}

function getTdotConfig(env = process.env) {
	const contactEmail = String(env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the scraper User-Agent');

	return {
		...getTdotOfflineConfig(env),
		storefrontUrl: env.TDOT_STOREFRONT_URL || DEFAULTS.storefrontUrl,
		klevuConfigBaseUrl: env.TDOT_KLEVU_CONFIG_BASE_URL || DEFAULTS.klevuConfigBaseUrl,
		pageSize: intFrom(env.TDOT_PAGE_SIZE, DEFAULTS.pageSize, 10, PAGE_SIZE_MAX),
		requestDelayMs: intFrom(env.TDOT_REQUEST_DELAY_MS, DEFAULTS.requestDelayMs, 0, 60000),
		concurrency: intFrom(env.TDOT_CONCURRENCY, DEFAULTS.concurrency, 1, 4),
		maxPrice: intFrom(env.TDOT_MAX_PRICE, DEFAULTS.maxPrice, 1, 1000000),
		brandCrawlMaxItems: intFrom(env.TDOT_BRAND_CRAWL_MAX_ITEMS, DEFAULTS.brandCrawlMaxItems, 100, 1000000),
		perProductResults: intFrom(env.TDOT_PER_PRODUCT_RESULTS, DEFAULTS.perProductResults, 1, PAGE_SIZE_MAX),
		consecutiveFailureLimit: intFrom(env.TDOT_CONSECUTIVE_FAILURE_LIMIT, DEFAULTS.consecutiveFailureLimit, 1, 10000),
		maxRequests: intFrom(env.TDOT_MAX_REQUESTS, DEFAULTS.maxRequests, 1, 1000000),
		maxRunMinutes: intFrom(env.TDOT_MAX_RUN_MINUTES, DEFAULTS.maxRunMinutes, 1, 1440),
		labelLimit: intFrom(env.TDOT_LABEL_LIMIT, DEFAULTS.labelLimit, 0, 10000),
		fallbackApiKey: String(env.TDOT_KLEVU_API_KEY || '').trim(),
		fallbackSearchDomain: String(env.TDOT_KLEVU_SEARCH_DOMAIN || '').trim(),
		contactEmail,
		userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`,
	};
}

module.exports = { getTdotConfig, getTdotOfflineConfig, DEFAULTS };
