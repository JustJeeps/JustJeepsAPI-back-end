// Orchestration: discover the key, walk the pages politely (concurrency 1,
// jitter), normalize, run the canaries, build the payload. Pure: fetch,
// sleep, now, withRetry and logger are injected so tests need no network.

const { discoverConfig } = require('./discoverConfig');
const { createPartslogicClient } = require('./partslogicClient');
const { normalizeItems, dedupeItems, buildPayload } = require('./normalize');
const { checkCollection } = require('./canaries');

const JITTER_MS = 500;

class LowridersCollectError extends Error {
	constructor(failures) {
		super(`LOWRIDERS_CANARY_FAILED: ${failures.map((f) => `${f.code} (${f.message})`).join('; ')}`);
		this.code = 'LOWRIDERS_CANARY_FAILED';
		this.failures = failures;
	}
}

async function collectLowriders({ fetch, config, runId = null, logger, sleep, now = () => new Date(), withRetry, random = Math.random }) {
	const discoverArgs = {
		fetch, brandPageUrl: config.brandPageUrl, fallbackApiKey: config.fallbackApiKey,
		userAgent: config.userAgent, timeoutMs: config.timeoutMs, logger,
	};
	const clientArgs = { fetch, baseUrl: config.apiBaseUrl, userAgent: config.userAgent, timeoutMs: config.timeoutMs };

	let discovered = await discoverConfig(discoverArgs);
	let client = createPartslogicClient({ ...clientArgs, apiKey: discovered.apiKey });
	let rediscovered = false;

	// A 404 means the key we read is no longer accepted: read the page again
	// once. A second 404 is a real outage and must surface.
	async function fetchPage(page) {
		try {
			return await client.fetchPage({ brandId: config.brandId, page, limit: config.pageSize });
		} catch (err) {
			if (err.code !== 'LOWRIDERS_KEY_REJECTED' || rediscovered) throw err;
			rediscovered = true;
			logger.warn('[lowriders] API key rejected, re-reading the brand page once');
			discovered = await discoverConfig(discoverArgs);
			client = createPartslogicClient({ ...clientArgs, apiKey: discovered.apiKey });
			return client.fetchPage({ brandId: config.brandId, page, limit: config.pageSize });
		}
	}

	const rawItems = [];
	let reportedTotal = 0;
	let pagesFetched = 0;
	let page = 1;
	for (;;) {
		const { list, total } = await withRetry(() => fetchPage(page), `lowriders page ${page}`, { maxRetries: 4, baseDelayMs: 1000 });
		pagesFetched += 1;
		if (page === 1) reportedTotal = total;
		rawItems.push(...list);

		const maxPages = Math.ceil(Math.max(reportedTotal, 1) / config.pageSize) + 1;
		const done = list.length < config.pageSize || page * config.pageSize >= reportedTotal || page >= maxPages;
		if (done) break;
		page += 1;
		await sleep(config.pageDelayMs + Math.floor(random() * JITTER_MS));
	}

	const normalized = normalizeItems(rawItems, { maxPrice: config.maxPrice });
	const deduped = dedupeItems(normalized.items);
	const check = checkCollection({
		items: deduped.items, reportedTotal, invalidCount: normalized.invalidCount, duplicateCount: deduped.duplicateCount, thresholds: config.thresholds,
	});
	logger.info(`[lowriders] step=collect pages=${pagesFetched} items=${deduped.items.length} reportedTotal=${reportedTotal} invalid=${normalized.invalidCount} duplicates=${deduped.duplicateCount} configSource=${discovered.source}`);
	if (!check.ok) {
		for (const failure of check.failures) logger.error(`[lowriders] CANARY FAILED code=${failure.code} detail=${JSON.stringify(failure.detail)}`);
		throw new LowridersCollectError(check.failures);
	}

	const payload = buildPayload({
		items: deduped.items, runId, capturedAt: now().toISOString(), reportedTotal, pagesFetched, pageSize: config.pageSize,
		configSource: discovered.source, invalidCount: normalized.invalidCount, duplicateCount: deduped.duplicateCount, brandId: config.brandId,
	});
	return { payload, stats: check.stats, invalidSample: normalized.invalidSample, configSource: discovered.source };
}

module.exports = { collectLowriders, LowridersCollectError };
