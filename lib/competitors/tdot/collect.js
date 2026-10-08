// Orchestration (DD-019): discover the Klevu config, probe each label we sell,
// pick crawl or per-product per label, fetch politely, normalize, match
// against OUR products, run the canaries, build the payload. Pure: fetch,
// sleep, now, withRetry, withConcurrency and logger are injected, so tests
// need no network. A failed request is recorded and the run goes on; only
// the canaries and the circuit breaker abort, before anything is written.

const { discoverConfig } = require('./discoverConfig');
const { createKlevuClient } = require('./klevuClient');
const { normalizeRecords, dedupeItems, tdotCodeFromRecord, isCategoryRecord } = require('./normalize');
const { buildTargetIndex, matchItems } = require('./match');
const { planLabels } = require('./plan');
const { checkTdotRun } = require('./canaries');

const SOURCE = 'tdot';
const COMPETITOR = Object.freeze({ name: 'TDOT', website: 'https://www.tdotperformance.ca/' });
const JITTER_MS = 300;
const FAILURE_SAMPLE_LIMIT = 50;
const UNMATCHED_SAMPLE_PER_LABEL = 5;
const PROBE_RESULTS = 20;
const PROBE_SAMPLE = 3;
const PRODUCT_PROBES = 3;
const KLEVU_MAX_RESULTS = 100; // Klevu caps noOfResults at 100 (config/tdot.js PAGE_SIZE_MAX)
const PROGRESS_EVERY = 10;
const CONSECUTIVE_FAILURES_LIMIT = 10;
const MIN_TOKEN_PREFIX = 3;
const RECORD_FIELDS = ['id', 'sku', 'name', 'price', 'salePrice', 'oldPrice', 'startPrice', 'discount', 'currency', 'url', 'inStock'];
const BUDGET = Symbol('budget-exhausted');

class TdotCollectError extends Error {
	constructor(code, message, failures = []) {
		super(`${code}: ${message}`);
		this.code = code;
		this.failures = failures;
	}
}

const compact = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "FoxShox-883-06-257" -> "FoxShox": the brand token TDOT uses in its skus.
function brandTokenOf(record) {
	const sku = record && typeof record.sku === 'string' ? record.sku.trim() : '';
	const dash = sku.indexOf('-');
	return dash > 0 ? sku.slice(0, dash) : '';
}

function commonPrefixLength(a, b) {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
	return n;
}

// A token is only worth probing when it plausibly spells our label: "FoxShox"
// for "Fox Racing" (shared "fox"), "OmixADA" for "Omix-ADA"; never "Carr" for
// "Alloy USA", "Daystar" for "Smittybilt", nor the "N" of "N-Fab".
function tokenLooksLikeLabel(token, label) {
	const t = compact(token);
	const l = compact(label);
	return t.length >= MIN_TOKEN_PREFIX && t !== l && commonPrefixLength(t, l) >= MIN_TOKEN_PREFIX;
}

// Does the probe show items of this brand? A label TDOT does not sell returns
// other brands (or nothing), and must not be crawled or queried per product.
function hasBrandItems(records, term) {
	const wanted = compact(term);
	if (!wanted) return false;
	return (records || []).some((r) => !isCategoryRecord(r) && (compact(tdotCodeFromRecord(r)).startsWith(wanted) || compact(r && r.sku).startsWith(wanted)));
}

// Product.tdot_code is "<label> <searchable_sku>"; the label is what is left.
function labelOfProduct(product) {
	const code = String(product?.tdot_code ?? '').trim();
	if (!code) return null;
	const part = String(product?.searchable_sku ?? '').trim();
	if (part && code.endsWith(` ${part}`)) return code.slice(0, -(part.length + 1)).trim() || null;
	return code.split(' ')[0] || null;
}

function groupTargetsByLabel(targets, labels) {
	const byLabel = new Map();
	for (const label of labels || []) if (label) byLabel.set(label, []);
	for (const product of targets || []) {
		const label = labelOfProduct(product);
		if (!label) continue;
		if (!byLabel.has(label)) byLabel.set(label, []);
		byLabel.get(label).push(product);
	}
	return [...byLabel.entries()].filter(([, products]) => products.length > 0).map(([label, products]) => ({ label, products }));
}

// Only the fields the pipeline reads: 184k raw records with every Klevu field
// would hold a few hundred MB in a 768 MB child heap.
function slimRecord(raw) {
	if (!raw || typeof raw !== 'object') return raw;
	const slim = {};
	for (const field of RECORD_FIELDS) if (raw[field] !== undefined) slim[field] = raw[field];
	return slim;
}

const probeSampleOf = (records) => (records || []).filter((r) => !isCategoryRecord(r)).slice(0, PROBE_SAMPLE).map(tdotCodeFromRecord);

async function collectTdot({
	fetch, config, targets, labels, runId = null, logger, sleep, now = () => new Date(),
	withRetry, withConcurrency, random = Math.random,
}) {
	const startedAt = now();
	const msSince = (from) => now().getTime() - from.getTime();
	const timing = { discoverMs: 0, probeMs: 0, fetchMs: 0, matchMs: 0 };
	let phaseStart = startedAt;
	const discovered = await discoverConfig({
		fetch, storefrontUrl: config.storefrontUrl, klevuConfigBaseUrl: config.klevuConfigBaseUrl,
		fallbackApiKey: config.fallbackApiKey, fallbackSearchDomain: config.fallbackSearchDomain,
		userAgent: config.userAgent, timeoutMs: config.timeoutMs, logger,
	});
	const client = createKlevuClient({ fetch, apiKey: discovered.apiKey, searchDomain: discovered.searchDomain, userAgent: config.userAgent, timeoutMs: config.timeoutMs });
	timing.discoverMs = msSince(phaseStart);
	const perProductResults = config.perProductResults || 20;
	const consecutiveFailureLimit = config.consecutiveFailureLimit || CONSECUTIVE_FAILURES_LIMIT;

	const counters = { requests: 0, httpAttempts: 0, failedRequests: 0, consecutiveFailures: 0 };
	const failures = [];
	let failuresTruncated = false;
	let partial = false;
	const timeIsUp = () => (now().getTime() - startedAt.getTime()) > config.maxRunMinutes * 60 * 1000;

	// One guarded request. Retryable errors (timeouts, 429, 5xx) go through
	// withRetry; a definitive one (404, bad body) is fetched once. A failure
	// is recorded and the caller gets null; the time budget returns BUDGET.
	// Set when the circuit breaker trips: the other worker drains its queue
	// without another request while the error unwinds.
	let aborted = false;
	async function request(label, term, params) {
		if (aborted) return null;
		if (timeIsUp()) {
			partial = true;
			return BUDGET;
		}
		counters.requests += 1;
		let definitive = null;
		try {
			const page = await withRetry(async () => {
				counters.httpAttempts += 1;
				try {
					return await client.search({ term, ...params });
				} catch (err) {
					if (err.retryable) throw err;
					definitive = err;
					return null;
				}
			}, `tdot ${label}: ${term}`, { maxRetries: 3, baseDelayMs: 1000 });
			if (definitive) throw definitive;
			counters.consecutiveFailures = 0;
			return { ...page, records: page.records.map(slimRecord) };
		} catch (err) {
			counters.failedRequests += 1;
			counters.consecutiveFailures += 1;
			const code = err.code || 'TDOT_REQUEST_FAILED';
			if (failures.length < FAILURE_SAMPLE_LIMIT) failures.push({ label, term, code, status: err.status ?? null, message: err.message });
			else failuresTruncated = true;
			logger.warn(`[tdot] step=fetch label="${label}" term="${term}" code=${code} status=${err.status ?? '-'} message="${err.message}"`);
			if (counters.consecutiveFailures >= consecutiveFailureLimit) {
				aborted = true;
				throw new TdotCollectError('TDOT_SOURCE_UNAVAILABLE', `${consecutiveFailureLimit} consecutive requests failed; last: ${code} ${err.message}`);
			}
			return null;
		} finally {
			await sleep(config.requestDelayMs + Math.floor(random() * JITTER_MS));
		}
	}

	// Phase A: one probe per label we sell, to learn how big it is on TDOT and
	// whether TDOT sells it at all. TDOT's own brand token (the sku prefix,
	// "FoxShox") can differ from our label ("Fox Racing"): when it plausibly
	// spells the same brand, probe it too and keep the term that returns more.
	// Probes run on the same worker pool and pacing as the fetch. The probe asks
	// for a full page, so the chosen term's answer is also page 1 of the crawl;
	// decisions still look at the first PROBE_RESULTS records only.
	phaseStart = now();
	let groups = groupTargetsByLabel(targets, labels);
	if (config.labelLimit > 0) groups = groups.slice(0, config.labelLimit);
	let budgetHit = false;
	// Ask at least PROBE_RESULTS records, so a small page size never narrows
	// what the decision sees. The answer doubles as a fetch request only when
	// it is exactly that request (same size).
	const labelProbeSize = Math.min(Math.max(config.pageSize, PROBE_RESULTS), KLEVU_MAX_RESULTS);
	const productProbeSize = Math.min(Math.max(perProductResults, PROBE_RESULTS), KLEVU_MAX_RESULTS);
	const reuseLabelProbe = labelProbeSize === config.pageSize;
	const reuseProductProbe = productProbeSize === perProductResults;
	const probePage = (label, term) => request(label, term, { noOfResults: labelProbeSize, paginationStartsFrom: 0 });
	const head = (records) => (records || []).slice(0, PROBE_RESULTS);

	async function probeLabel(group) {
		const entry = { label: group.label, term: group.label, products: group.products, total: 0, probeFailed: false, overBudget: false, notOnTdot: false, probeSample: [], firstPage: null, prefetched: new Map() };
		if (budgetHit) {
			entry.overBudget = true;
			return entry;
		}
		const page = await probePage(group.label, group.label);
		if (page === BUDGET) {
			budgetHit = true;
			entry.overBudget = true;
			return entry;
		}
		if (page === null) {
			entry.probeFailed = true;
			return entry;
		}
		entry.total = page.total;
		if (reuseLabelProbe) entry.firstPage = page.records;
		entry.probeSample = probeSampleOf(head(page.records));
		let present = hasBrandItems(head(page.records), group.label);
		const token = brandTokenOf(head(page.records).find((r) => r && r.sku));
		if (token && tokenLooksLikeLabel(token, group.label)) {
			const alt = await probePage(group.label, token);
			if (alt && alt !== BUDGET && hasBrandItems(head(alt.records), token) && (!present || alt.total > entry.total)) {
				entry.term = token;
				entry.total = alt.total;
				entry.firstPage = reuseLabelProbe ? alt.records : null;
				present = true;
			}
		}
		// A generic label word can drown the brand: "Fuel" returns Edelbrock fuel
		// pumps first, though TDOT sells Fuel wheels (2026-10-06). Before giving
		// up, search a few of our own products by tdot_code; a hit means the
		// brand is there and only per-product queries can reach it. Each answer
		// is the same query the per-product fetch would make, so it is kept.
		if (!present) {
			for (const product of group.products.slice(0, PRODUCT_PROBES)) {
				const hit = await request(group.label, product.tdot_code, { noOfResults: productProbeSize, paginationStartsFrom: 0 });
				if (hit === BUDGET) break;
				if (!hit) continue;
				if (reuseProductProbe) entry.prefetched.set(product.tdot_code, hit.records);
				if (hasBrandItems(head(hit.records), group.label)) {
					present = true;
					entry.perProductOnly = true;
					logger.info(`[tdot] step=probe label="${group.label}" found-by-product term="${product.tdot_code}"`);
					break;
				}
			}
		}
		entry.notOnTdot = !present;
		if (entry.notOnTdot) {
			logger.warn(`[tdot] step=probe label="${group.label}" not-on-tdot products=${group.products.length} sample=${JSON.stringify(entry.probeSample)}`);
		}
		return entry;
	}

	const probed = await withConcurrency(groups, config.concurrency, probeLabel);

	timing.probeMs = msSince(phaseStart);

	// Phase B: plan within what is left of the request budget, then fetch.
	phaseStart = now();
	const plan = planLabels(
		probed.map((p) => ({ label: p.label, total: p.notOnTdot || p.probeFailed || p.overBudget ? 0 : p.total, ourProducts: p.products.length, perProductOnly: Boolean(p.perProductOnly) && !p.notOnTdot && !p.probeFailed && !p.overBudget })),
		{ pageSize: config.pageSize, brandCrawlMaxItems: config.brandCrawlMaxItems, maxRequests: Math.max(config.maxRequests - counters.requests, 0) },
	);
	const planByLabel = new Map(plan.map((p) => [p.label, p]));
	for (const entry of probed) {
		const planned = planByLabel.get(entry.label);
		if (entry.probeFailed) Object.assign(planned, { mode: 'probe-failed', requests: 0 });
		else if (entry.overBudget) Object.assign(planned, { mode: 'over-budget', requests: 0 });
		else if (entry.notOnTdot) Object.assign(planned, { mode: 'not-on-tdot', requests: 0 });
		if (planned.mode === 'over-budget') partial = true;
	}
	// One shared queue of single requests (a crawl page or one product), not
	// one task per label: Power Stop alone used to hold a worker for 4 minutes
	// while the other sat idle at the end. Every answer lands in its own slot,
	// so each label's records keep the same order as a sequential fetch, and
	// the duplicate tie-break in matchItems stays deterministic.
	const tasks = [];
	const slotsByLabel = new Map();
	for (const entry of probed) {
		const planned = planByLabel.get(entry.label);
		const slots = [];
		slotsByLabel.set(entry.label, slots);
		if (planned.mode === 'crawl') {
			const pages = Math.ceil(entry.total / config.pageSize);
			const from = entry.firstPage ? 1 : 0;
			if (entry.firstPage) slots.push(entry.firstPage);
			for (let i = from; i < pages; i += 1) {
				const slot = slots.push(null) - 1;
				tasks.push({ entry, slot, term: entry.term, params: { noOfResults: config.pageSize, paginationStartsFrom: i * config.pageSize } });
			}
			planned.requests = Math.max(pages - from, 0);
		} else if (planned.mode === 'per-product') {
			let queries = 0;
			for (const product of entry.products) {
				if (entry.prefetched.has(product.tdot_code)) {
					slots.push(entry.prefetched.get(product.tdot_code));
					continue;
				}
				const slot = slots.push(null) - 1;
				tasks.push({ entry, slot, term: product.tdot_code, params: { noOfResults: perProductResults, paginationStartsFrom: 0 } });
				queries += 1;
			}
			planned.requests = queries;
		}
	}

	// Biggest labels first (longest processing time first): their requests are
	// spread over both workers from the start instead of trailing at the end.
	const order = new Map([...probed].sort((x, y) => planByLabel.get(y.label).requests - planByLabel.get(x.label).requests).map((e, i) => [e.label, i]));
	tasks.sort((x, y) => order.get(x.entry.label) - order.get(y.entry.label) || x.slot - y.slot);

	const pendingByLabel = new Map(probed.map((e) => [e.label, 0]));
	for (const task of tasks) pendingByLabel.set(task.entry.label, pendingByLabel.get(task.entry.label) + 1);
	const labelStart = new Map();
	const labelMs = new Map();
	let labelsDone = probed.filter((e) => pendingByLabel.get(e.label) === 0).length;
	await withConcurrency(tasks, config.concurrency, async (task) => {
		const { label } = task.entry;
		if (!labelStart.has(label)) labelStart.set(label, now());
		try {
			const page = await request(label, task.term, task.params);
			if (page && page !== BUDGET) slotsByLabel.get(label)[task.slot] = page.records;
		} finally {
			const left = pendingByLabel.get(label) - 1;
			pendingByLabel.set(label, left);
			if (left === 0) {
				labelMs.set(label, msSince(labelStart.get(label)));
				labelsDone += 1;
				if (labelsDone % PROGRESS_EVERY === 0 || labelsDone === probed.length) {
					logger.info(`[tdot] step=fetch progress=${labelsDone}/${probed.length} labels requests=${counters.requests} failed=${counters.failedRequests}`);
				}
			}
		}
	});
	const rawByLabel = new Map();
	for (const entry of probed) rawByLabel.set(entry.label, slotsByLabel.get(entry.label).filter(Boolean).flat());
	if (timeIsUp()) partial = true;
	timing.fetchMs = msSince(phaseStart);

	// Phase C: normalize per label (so unmatched items keep their label),
	// dedupe, match against our catalog.
	phaseStart = now();
	const items = [];
	let rawCount = 0;
	let invalidCount = 0;
	let categoryCount = 0;
	const invalidSample = [];
	for (const [label, records] of rawByLabel.entries()) {
		rawCount += records.length;
		const normalized = normalizeRecords(records, { maxPrice: config.maxPrice });
		invalidCount += normalized.invalidCount;
		categoryCount += normalized.categoryCount;
		if (invalidSample.length < 25) invalidSample.push(...normalized.invalidSample.slice(0, 25 - invalidSample.length));
		for (const item of normalized.items) items.push({ ...item, label });
	}
	const deduped = dedupeItems(items);
	const index = buildTargetIndex(targets);
	const match = matchItems(deduped.items, index);
	const productLabel = new Map((targets || []).map((p) => [p.sku, labelOfProduct(p)]));
	const matchedPerLabel = new Map();
	for (const m of match.matched) {
		const label = productLabel.get(m.productSku);
		matchedPerLabel.set(label, (matchedPerLabel.get(label) || 0) + 1);
	}
	const unmatchedPerLabel = new Map();
	for (const u of match.unmatched) {
		const bucket = unmatchedPerLabel.get(u.label) || { count: 0, sample: [] };
		bucket.count += 1;
		if (bucket.sample.length < UNMATCHED_SAMPLE_PER_LABEL) bucket.sample.push(u.competitorSku);
		unmatchedPerLabel.set(u.label, bucket);
	}
	const comparableRaw = rawCount - categoryCount;
	timing.matchMs = msSince(phaseStart);

	const check = checkTdotRun(
		{ requests: counters.requests, failedRequests: counters.failedRequests, matched: match.matched.length, rawCount: comparableRaw, invalidCount },
		config.thresholds,
	);
	const labelsByMode = (mode) => plan.filter((p) => p.mode === mode).length;
	logger.info(`[tdot] step=collect labels=${probed.length} crawl=${labelsByMode('crawl')} perProduct=${labelsByMode('per-product')} notOnTdot=${labelsByMode('not-on-tdot')} probeFailed=${labelsByMode('probe-failed')} overBudget=${labelsByMode('over-budget')} requests=${counters.requests} httpAttempts=${counters.httpAttempts} failed=${counters.failedRequests} raw=${rawCount} categories=${categoryCount} invalid=${invalidCount} duplicates=${deduped.duplicateCount + match.duplicateCount} matched=${match.matched.length} unmatched=${match.unmatched.length} ambiguous=${match.ambiguous.length} partial=${partial} configSource=${discovered.source}`);
	if (partial) logger.warn(`[tdot] step=collect PARTIAL run: the request or time budget stopped the crawl; ${labelsByMode('over-budget')} labels not fetched`);
	if (!check.ok) {
		for (const failure of check.failures) logger.error(`[tdot] CANARY FAILED code=${failure.code} detail=${JSON.stringify(failure.detail)}`);
		throw new TdotCollectError('TDOT_CANARY_FAILED', check.failures.map((f) => `${f.code} (${f.message})`).join('; '), check.failures);
	}

	const bySku = new Map((targets || []).map((p) => [p.sku, p]));
	const payload = {
		schemaVersion: 1,
		source: SOURCE,
		competitor: { ...COMPETITOR },
		runId,
		capturedAt: now().toISOString(),
		collection: {
			labelsPlanned: probed.length,
			labelsCrawled: labelsByMode('crawl'),
			labelsPerProduct: labelsByMode('per-product'),
			labelsSkipped: labelsByMode('skip'),
			labelsOverBudget: labelsByMode('over-budget'),
			labelsProbeFailed: labelsByMode('probe-failed'),
			labelsNotOnTdot: labelsByMode('not-on-tdot'),
			requests: counters.requests,
			httpAttempts: counters.httpAttempts,
			failedRequests: counters.failedRequests,
			rawCount,
			categoryCount,
			invalidCount,
			duplicateCount: deduped.duplicateCount + match.duplicateCount,
			matched: match.matched.length,
			unmatched: match.unmatched.length,
			ambiguous: match.ambiguous.length,
			partial,
			perProductResults,
			configSource: discovered.source,
			durationMs: msSince(startedAt),
			timing,
		},
		labelStats: plan.map((p) => {
			const entry = probed.find((e) => e.label === p.label);
			const unmatched = unmatchedPerLabel.get(p.label) || { count: 0, sample: [] };
			return {
				label: p.label, mode: p.mode, term: entry.term, total: p.total, requests: p.requests, durationMs: labelMs.get(p.label) || 0, ourProducts: entry.products.length,
				matched: matchedPerLabel.get(p.label) || 0, unmatched: unmatched.count, unmatchedSample: unmatched.sample, probeSample: entry.probeSample,
			};
		}),
		items: match.matched.map((m) => {
			const product = bySku.get(m.productSku);
			return {
				tdotCode: m.tdotCode,
				productSku: m.productSku,
				competitorSku: m.item.competitorSku,
				partNumber: (product && product.searchable_sku) || m.item.partNumber,
				title: m.item.title,
				sourceId: m.item.sourceId,
				effectivePrice: m.item.effectivePrice,
				regularPrice: m.item.regularPrice,
				salePrice: m.item.salePrice,
				oldPrice: m.item.oldPrice,
				discount: m.item.discount,
				rawPrice: m.item.rawPrice,
				url: m.item.url,
				inStock: m.item.inStock,
			};
		}),
		ambiguous: match.ambiguous,
		invalidSample,
		failures,
		failuresTruncated,
	};
	return { payload, stats: check.stats, configSource: discovered.source };
}

module.exports = { collectTdot, labelOfProduct, groupTargetsByLabel, tokenLooksLikeLabel, hasBrandItems, TdotCollectError, SOURCE, COMPETITOR };
