// Lowriders competitor prices (DD-018): env -> config for the collector and
// the ingest floor. Pure: process.env and literals only, same rule as
// config/cron-jobs.js, so tests and verify scripts can load it.

const DEFAULTS = Object.freeze({
	brandPageUrl: 'https://www.lowriders.ca/b-90296-rough-country.html?facet-brands=90296',
	apiBaseUrl: 'https://api.sunhammer.io',
	brandId: 90296,
	pageSize: 500,
	pageDelayMs: 750,
	timeoutMs: 30000,
	maxPrice: 20000,
	minCollectRatio: 0.9,
	minItems: 5000,
	minMatched: 500,
	matchDropRatio: 0.8,
});

const PAGE_SIZE_MAX = 1000; // verified against the API on 2026-09-17

function intFrom(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), min), max);
}

function ratioFrom(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

function getLowridersConfig(env = process.env) {
	const contactEmail = String(env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the scraper User-Agent');

	return {
		brandPageUrl: env.LOWRIDERS_BRAND_PAGE_URL || DEFAULTS.brandPageUrl,
		apiBaseUrl: env.LOWRIDERS_API_BASE_URL || DEFAULTS.apiBaseUrl,
		brandId: intFrom(env.LOWRIDERS_BRAND_ID, DEFAULTS.brandId, 1, Number.MAX_SAFE_INTEGER),
		pageSize: intFrom(env.LOWRIDERS_PAGE_SIZE, DEFAULTS.pageSize, 20, PAGE_SIZE_MAX),
		pageDelayMs: intFrom(env.LOWRIDERS_PAGE_DELAY_MS, DEFAULTS.pageDelayMs, 0, 60000),
		timeoutMs: intFrom(env.LOWRIDERS_REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs, 1000, 120000),
		maxPrice: intFrom(env.LOWRIDERS_MAX_PRICE, DEFAULTS.maxPrice, 1, 1000000),
		fallbackApiKey: String(env.LOWRIDERS_PARTSLOGIC_API_KEY || '').trim(),
		contactEmail,
		userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`,
		thresholds: {
			minCollectRatio: ratioFrom(env.LOWRIDERS_MIN_COLLECT_RATIO, DEFAULTS.minCollectRatio),
			minItems: intFrom(env.LOWRIDERS_MIN_ITEMS, DEFAULTS.minItems, 0, Number.MAX_SAFE_INTEGER),
			minMatched: intFrom(env.LOWRIDERS_MIN_MATCHED, DEFAULTS.minMatched, 0, Number.MAX_SAFE_INTEGER),
			matchDropRatio: ratioFrom(env.LOWRIDERS_MATCH_DROP_RATIO, DEFAULTS.matchDropRatio),
		},
	};
}

module.exports = { getLowridersConfig, DEFAULTS };
