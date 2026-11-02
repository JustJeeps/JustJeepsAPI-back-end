// Niagara Jeeps competitor prices (DD-021): env -> config for the collector
// and the ingest guards. Pure: process.env and literals only, same rule as
// config/cron-jobs.js, so tests and verify scripts can load it.

const COMPETITOR = Object.freeze({ name: 'Niagara Jeeps', website: 'https://niagarajeeps.ca/' });

const DEFAULTS = Object.freeze({
	baseUrl: 'https://niagarajeeps.ca',
	pageSize: 250,
	requestDelayMs: 3000,
	jitterMs: 1000,
	timeoutMs: 30000,
	maxPrice: 20000,
	maxAttempts: 3,
	backoffMs: 2000,
	retryAfterCapMs: 120000,
	challengeRetryDelayMs: 60000,
	consecutiveFailureLimit: 5,
	maxRequests: 1500,
	maxRunMinutes: 120,
	maxPagesPerBrand: 100,
	minItems: 1000,
	minMatched: 200,
	maxFailedRequestRatio: 0.1,
	maxBrandsFailedRatio: 0.2,
	maxInvalidRatio: 0.02,
	matchDropRatio: 0.8,
});

const PAGE_SIZE_MAX = 250; // Shopify products.json limit
const MIN_REQUEST_DELAY_MS = 1000;
// page * limit may not pass 25,000 (verified 2026-11-02), so 100 pages of 250.
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

function getNiagaraOfflineConfig(env = process.env) {
	return {
		maxPrice: intFrom(env.NIAGARA_MAX_PRICE, DEFAULTS.maxPrice, 1, 1000000),
		thresholds: {
			minItems: intFrom(env.NIAGARA_MIN_ITEMS, DEFAULTS.minItems, 0, Number.MAX_SAFE_INTEGER),
			minMatched: intFrom(env.NIAGARA_MIN_MATCHED, DEFAULTS.minMatched, 1, Number.MAX_SAFE_INTEGER),
			maxFailedRequestRatio: ratioFrom(env.NIAGARA_MAX_FAILED_REQUEST_RATIO, DEFAULTS.maxFailedRequestRatio),
			maxBrandsFailedRatio: ratioFrom(env.NIAGARA_MAX_BRANDS_FAILED_RATIO, DEFAULTS.maxBrandsFailedRatio),
			maxInvalidRatio: ratioFrom(env.NIAGARA_MAX_INVALID_RATIO, DEFAULTS.maxInvalidRatio),
			matchDropRatio: ratioFrom(env.NIAGARA_MATCH_DROP_RATIO, DEFAULTS.matchDropRatio),
		},
	};
}

function getNiagaraConfig(env = process.env) {
	const contactEmail = String(env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the scraper User-Agent');

	return {
		...getNiagaraOfflineConfig(env),
		baseUrl: env.NIAGARA_BASE_URL || DEFAULTS.baseUrl,
		pageSize: intFrom(env.NIAGARA_PAGE_SIZE, DEFAULTS.pageSize, 1, PAGE_SIZE_MAX),
		requestDelayMs: intFrom(env.NIAGARA_REQUEST_DELAY_MS, DEFAULTS.requestDelayMs, MIN_REQUEST_DELAY_MS, 60000),
		jitterMs: intFrom(env.NIAGARA_JITTER_MS, DEFAULTS.jitterMs, 0, 10000),
		timeoutMs: intFrom(env.NIAGARA_REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs, 1000, 120000),
		maxAttempts: intFrom(env.NIAGARA_MAX_ATTEMPTS, DEFAULTS.maxAttempts, 1, 10),
		backoffMs: intFrom(env.NIAGARA_BACKOFF_MS, DEFAULTS.backoffMs, 0, 60000),
		retryAfterCapMs: intFrom(env.NIAGARA_RETRY_AFTER_CAP_MS, DEFAULTS.retryAfterCapMs, 1000, 600000),
		challengeRetryDelayMs: intFrom(env.NIAGARA_CHALLENGE_RETRY_DELAY_MS, DEFAULTS.challengeRetryDelayMs, 0, 600000),
		consecutiveFailureLimit: intFrom(env.NIAGARA_CONSECUTIVE_FAILURE_LIMIT, DEFAULTS.consecutiveFailureLimit, 1, 100),
		maxRequests: intFrom(env.NIAGARA_MAX_REQUESTS, DEFAULTS.maxRequests, 1, 100000),
		maxRunMinutes: intFrom(env.NIAGARA_MAX_RUN_MINUTES, DEFAULTS.maxRunMinutes, 1, 600),
		maxPagesPerBrand: intFrom(env.NIAGARA_MAX_PAGES_PER_BRAND, DEFAULTS.maxPagesPerBrand, 1, MAX_PAGES),
		contactEmail,
		userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`,
	};
}

module.exports = { getNiagaraConfig, getNiagaraOfflineConfig, COMPETITOR, DEFAULTS };
