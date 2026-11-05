// Niagara Jeeps collector (DD-021): crawls the Shopify collection of every
// mapped brand (/collections/<handle>/products.json, 250 per page) one request
// at a time, and returns payload v1 for the ingest. Pure: fetch, sleep, clock
// and random are injected, and nothing here touches the database.
//
// The whole-store /products.json stops at 25,000 products and the catalog is
// larger, so brand collections are the only complete path. A collection can
// hold another vendor's products: those are dropped, and a brand where they
// pass 25% is dropped whole and counted as failed (the handle may point at a
// category). 5% was too tight: one house-brand product in an 8-product
// collection (dana-spicer) silently emptied the brand on every run.

const { createShopifyClient } = require('./shopifyClient');
const { createRequester } = require('./requester');
const { createCookieJar } = require('./cookieJar');
const { normalizeProduct, dedupeItems } = require('./normalize');
const { dominantVendor } = require('./brandMap');
const { checkCollection } = require('./canaries');

const SCHEMA_VERSION = 1;
const INDEX_PAGE_SIZE = 250;
const MAX_INDEX_PAGES = 20;
const MAX_FOREIGN_SHARE = 0.25;
const SHORT_RATIO = 0.9;
const SAMPLE_LIMIT = 25;
const BUDGET = Symbol('budget');

class NiagaraCollectError extends Error {
	constructor(code, message, failures = []) {
		super(`${code}: ${message}`);
		this.code = code;
		this.failures = failures;
	}
}

function createGuard({ requester, config, now, startedAt, logger }) {
	const counters = { failedRequests: 0, consecutiveFailures: 0 };
	const failures = [];
	let partial = false;
	const overBudget = () => requester.stats().requests >= config.maxRequests
		|| now().getTime() - startedAt.getTime() > config.maxRunMinutes * 60 * 1000;

	async function request(label, fn) {
		if (overBudget()) {
			partial = true;
			return BUDGET;
		}
		try {
			const value = await requester.run(label, fn);
			counters.consecutiveFailures = 0;
			return { value };
		} catch (error) {
			if (error.code === 'NIAGARA_CHALLENGED') {
				throw new NiagaraCollectError('NIAGARA_CHALLENGED', `${label}: the site answered with a Cloudflare challenge; nothing was written`);
			}
			counters.failedRequests += 1;
			counters.consecutiveFailures += 1;
			if (failures.length < SAMPLE_LIMIT) failures.push({ label, code: error.code || 'NIAGARA_REQUEST_FAILED', status: error.status ?? null, message: error.message });
			logger.warn(`[niagara] step=fetch ${label} code=${error.code || '-'} status=${error.status ?? '-'} message="${error.message}"`);
			if (counters.consecutiveFailures >= config.consecutiveFailureLimit) {
				throw new NiagaraCollectError('NIAGARA_SOURCE_UNAVAILABLE', `${config.consecutiveFailureLimit} consecutive requests failed; last: ${error.code} ${error.message}`, failures);
			}
			return { error };
		}
	}

	return { request, counters, failures, isPartial: () => partial };
}

async function loadIndex({ client, guard, logger }) {
	const counts = new Map();
	for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
		const result = await guard.request(`index page ${page}`, () => client.fetchCollectionsIndex(page, INDEX_PAGE_SIZE));
		if (result === BUDGET || result.error) {
			logger.warn('[niagara] collections index incomplete: handles are not checked against it');
			return null;
		}
		for (const c of result.value.collections) counts.set(c.handle, Number(c.products_count) || 0);
		if (result.value.collections.length < INDEX_PAGE_SIZE) return counts;
	}
	// Every page was full, so the index may go on: calling a brand missing on
	// a cut list would fail it for nothing.
	logger.warn(`[niagara] collections index has more than ${MAX_INDEX_PAGES} pages: handles are not checked against it`);
	return null;
}

function splitForeign(items, products) {
	const { vendor } = dominantVendor(products.map((p) => p.vendor));
	const own = items.filter((i) => i.vendor.toUpperCase() === vendor);
	return { vendor, own, foreign: items.length - own.length };
}

const emptyStats = (brand, expectedCount) => ({
	jjPrefix: brand.jjPrefix, handle: brand.handle, expectedCount, pages: 0, products: 0, variants: 0,
	items: 0, invalid: 0, foreign: 0, dominantVendor: '', status: 'ok',
});

const errorStatus = (code) => (code === 'NIAGARA_PAGE_CAP' ? 'page-cap' : code === 'NIAGARA_NOT_FOUND' ? 'missing-handle' : 'failed');

async function crawlBrand({ brand, client, guard, config, maxPages, expectedCount, sampled }) {
	const stats = emptyStats(brand, expectedCount);
	const seen = new Set();
	const products = [];
	const items = [];
	const invalid = [];
	for (let page = 1; page <= maxPages; page += 1) {
		const result = await guard.request(`brand ${brand.handle} page ${page}`, () => client.fetchCollectionPage({ handle: brand.handle, page, limit: config.pageSize }));
		if (result === BUDGET) return { stats: { ...stats, pages: page - 1, status: 'over-budget' }, items: [], invalid };
		if (result.error) {
			const status = errorStatus(result.error.code);
			// A failed page in the middle loses part of the brand: drop the brand
			// rather than write a partial price list. The page cap keeps what came.
			if (status !== 'page-cap' || page === 1) return { stats: { ...stats, pages: page - 1, status }, items: [], invalid };
			stats.status = 'page-cap';
			break;
		}
		stats.pages = page;
		for (const product of result.value.products.filter((p) => !seen.has(p.id))) {
			seen.add(product.id);
			products.push(product);
			const normalized = normalizeProduct(product, { baseUrl: config.baseUrl, maxPrice: config.maxPrice });
			stats.variants += (product.variants || []).length;
			items.push(...normalized.items.map((i) => ({ ...i, jjPrefix: brand.jjPrefix, handle: brand.handle })));
			invalid.push(...normalized.invalid.map((i) => ({ ...i, handle: brand.handle })));
		}
		if (result.value.products.length < config.pageSize) break;
		// The last allowed page came back full: there may be more products. A
		// sample stops early on purpose; a full run says so.
		if (page === maxPages && !sampled) stats.status = 'page-cap';
	}
	const counted = { ...stats, products: products.length, invalid: invalid.length };
	if (!products.length) return { stats: { ...counted, status: 'empty' }, items: [], invalid };

	const { vendor, own, foreign } = splitForeign(items, products);
	const impure = items.length > 0 && foreign / items.length > MAX_FOREIGN_SHARE;
	const kept = impure ? [] : own;
	let status = counted.status;
	if (impure) status = 'impure';
	else if (status === 'ok' && expectedCount && products.length < expectedCount * SHORT_RATIO) status = 'short';
	return { stats: { ...counted, dominantVendor: vendor, foreign, items: kept.length, status }, items: kept, invalid };
}

const FAILED_STATUSES = new Set(['failed', 'missing-handle', 'over-budget', 'impure']);

function summarize(brandStats) {
	const count = (s) => brandStats.filter((b) => b.status === s).length;
	return {
		brandsPlanned: brandStats.length,
		brandsOk: count('ok') + count('short') + count('page-cap'),
		brandsFailed: brandStats.filter((b) => FAILED_STATUSES.has(b.status)).length,
		brandsImpure: count('impure'),
		brandsEmpty: count('empty'),
	};
}

function collectionStats({ brandStats, requester, guard, invalid, items, duplicates, durationMs }) {
	const stats = requester.stats();
	const total = (field) => brandStats.reduce((n, b) => n + b[field], 0);
	return {
		...summarize(brandStats),
		requests: stats.requests, httpAttempts: stats.httpAttempts, retries: stats.retries,
		rateLimited: stats.rateLimited, challenged: stats.challenged, failedRequests: guard.counters.failedRequests,
		rawProducts: total('products'), rawVariants: total('variants'), invalidCount: invalid.length,
		foreignCount: total('foreign'), duplicateCount: duplicates.length, items: items.length,
		partial: guard.isPartial(), durationMs,
	};
}

// sample: null for a full run, or { brands, maxPages } for a sample run.
async function collectNiagara({ fetch, config, brands, runId = null, logger, sleep, now = () => new Date(), random = Math.random, sample = null }) {
	const startedAt = now();
	const client = createShopifyClient({ fetch, baseUrl: config.baseUrl, userAgent: config.userAgent, timeoutMs: config.timeoutMs, jar: createCookieJar() });
	const requester = createRequester({
		sleep, random, delayMs: config.requestDelayMs, jitterMs: config.jitterMs, maxAttempts: config.maxAttempts,
		backoffMs: config.backoffMs, retryAfterCapMs: config.retryAfterCapMs, challengeRetryDelayMs: config.challengeRetryDelayMs, logger,
	});
	const guard = createGuard({ requester, config, now, startedAt, logger });
	const samplePages = sample && sample.maxPages ? sample.maxPages : null;
	const maxPages = Math.min(config.maxPagesPerBrand, samplePages || Infinity);

	const index = await loadIndex({ client, guard, logger });
	const brandStats = [];
	const collected = [];
	const invalid = [];
	for (const brand of brands) {
		if (index && !index.has(brand.handle)) {
			brandStats.push({ ...emptyStats(brand, null), status: 'missing-handle' });
			logger.warn(`[niagara] brand ${brand.jjPrefix}: collection "${brand.handle}" is not in the index`);
			continue;
		}
		const expectedCount = index && !samplePages ? index.get(brand.handle) : null;
		const result = await crawlBrand({ brand, client, guard, config, maxPages, expectedCount, sampled: Boolean(samplePages) });
		brandStats.push(result.stats);
		collected.push(...result.items);
		invalid.push(...result.invalid);
		const s = result.stats;
		logger.info(`[niagara] brand ${brand.jjPrefix} (${brand.handle}): ${s.status} pages=${s.pages} products=${s.products} items=${s.items} foreign=${s.foreign}`);
	}

	const { items, duplicates } = dedupeItems(collected);
	const collection = collectionStats({ brandStats, requester, guard, invalid, items, duplicates, durationMs: now().getTime() - startedAt.getTime() });
	const verdict = checkCollection(collection, config.thresholds, { sample: Boolean(sample) });
	if (!verdict.ok) {
		throw new NiagaraCollectError('NIAGARA_CANARY_FAILED', verdict.failures.map((f) => f.message).join('; '), verdict.failures);
	}

	return {
		payload: { schemaVersion: SCHEMA_VERSION, source: 'niagara', runId, capturedAt: startedAt.toISOString(), sample, collection, brandStats, items, failures: guard.failures },
		invalidSample: invalid.slice(0, SAMPLE_LIMIT),
	};
}

module.exports = { collectNiagara, NiagaraCollectError, SCHEMA_VERSION };
