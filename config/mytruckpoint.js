// MyTruckPoint competitor prices (DD-022): env -> config for the collector
// and the ingest guards, read from MYTRUCKPOINT_* through the shared Shopify
// competitor reader (config/shopifyCompetitor.js). Pure: process.env and
// literals only, same rule as config/cron-jobs.js.

const { createShopifyCompetitorConfig } = require('./shopifyCompetitor');

const COMPETITOR = Object.freeze({ name: 'MyTruckPoint', website: 'https://www.mytruckpoint.ca/' });

// Volumes measured on 2026-11-19: about 900 requests for about 200k listings
// (22 index pages plus the mapped brand collections at 250 per page). The
// floors are low on purpose until the first real run sets measured ones in
// config/deploy.yml (MYTRUCKPOINT_MIN_ITEMS, MYTRUCKPOINT_MIN_MATCHED).
const DEFAULTS = Object.freeze({
	baseUrl: 'https://www.mytruckpoint.ca',
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
	maxRequests: 1600,
	maxRunMinutes: 120,
	maxPagesPerBrand: 100,
	snapshotMaxAgeHours: 72,
	minItems: 20000,
	minMatched: 1000,
	maxFailedRequestRatio: 0.1,
	maxBrandsFailedRatio: 0.2,
	maxInvalidRatio: 0.02,
	matchDropRatio: 0.8,
});

const { getConfig: getMytruckpointConfig, getOfflineConfig: getMytruckpointOfflineConfig } = createShopifyCompetitorConfig({ envPrefix: 'MYTRUCKPOINT', defaults: DEFAULTS });

module.exports = { getMytruckpointConfig, getMytruckpointOfflineConfig, COMPETITOR, DEFAULTS };
