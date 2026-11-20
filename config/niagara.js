// Niagara Jeeps competitor prices (DD-021): env -> config for the collector
// and the ingest guards, read from NIAGARA_* through the shared Shopify
// competitor reader (config/shopifyCompetitor.js, DD-022). Pure: process.env
// and literals only, same rule as config/cron-jobs.js.

const { createShopifyCompetitorConfig } = require('./shopifyCompetitor');

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
	snapshotMaxAgeHours: 72,
	minItems: 1000,
	minMatched: 200,
	maxFailedRequestRatio: 0.1,
	maxBrandsFailedRatio: 0.2,
	maxInvalidRatio: 0.02,
	matchDropRatio: 0.8,
});

const { getConfig: getNiagaraConfig, getOfflineConfig: getNiagaraOfflineConfig } = createShopifyCompetitorConfig({ envPrefix: 'NIAGARA', defaults: DEFAULTS });

module.exports = { getNiagaraConfig, getNiagaraOfflineConfig, COMPETITOR, DEFAULTS };
