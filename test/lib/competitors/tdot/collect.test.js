const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { collectTdot, labelOfProduct, TdotCollectError } = require('../../../../lib/competitors/tdot/collect');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/storefront-snippet.html'), 'utf8');
const klevuConfig = require('./fixtures/klevu-config.json');
const page0 = require('./fixtures/klevu-bestop-page0.json');
const page1 = require('./fixtures/klevu-bestop-page1.json');
const fuzzy = require('./fixtures/klevu-fuzzy-52401-01.json');

const silent = { info() {}, warn() {}, error() {} };
const noSleep = async () => {};
const noRetry = async (fn) => fn();
const now = () => new Date('2026-10-02T06:43:00.000Z');
const { withConcurrency } = require('../../../../lib/ingest/withRetry');

const config = {
	storefrontUrl: 'https://www.tdotperformance.ca/', klevuConfigBaseUrl: 'https://js.klevu.com/klevu-js-v1/klevu-js-api',
	pageSize: 5, requestDelayMs: 0, concurrency: 1, timeoutMs: 1000, maxPrice: 20000, brandCrawlMaxItems: 10000,
	maxRequests: 1000, maxRunMinutes: 60, labelLimit: 0, fallbackApiKey: '', fallbackSearchDomain: '', userAgent: 'test-ua',
	thresholds: { minMatched: 1, maxFailedRequestRatio: 0.5, maxInvalidRatio: 0.5 },
};

const targets = [
	{ sku: 'BST-52401-11', searchable_sku: '52401-11', tdot_code: 'Bestop 52401-11', status: 1 },
	{ sku: 'BST-42811-01', searchable_sku: '42811-01', tdot_code: 'Bestop 42811-01', status: 1 },
	{ sku: 'BST-99999-01', searchable_sku: '99999-01', tdot_code: 'Bestop 99999-01', status: 1 },
	{ sku: 'BST-00000-00', searchable_sku: '00000-00', tdot_code: 'Bestop 00000-00', status: 1 },
	{ sku: 'COV-C18001', searchable_sku: 'C18001', tdot_code: 'Covercraft C18001', status: 1 },
	{ sku: 'NOP-1', searchable_sku: '1', tdot_code: '', status: 1 },
];

// Routes a Klevu request by term: label probes answer totals, Bestop pages
// come from the fixtures, Covercraft is huge (per-product mode), everything
// else is a fuzzy miss. Records every call.
function makeFetch({ statusFor = () => 200, covercraftTotal = 92560 } = {}) {
	const calls = [];
	const fetch = async (url, opts = {}) => {
		calls.push({ url, headers: opts.headers || {} });
		if (url === config.storefrontUrl) return { ok: true, status: 200, text: async () => html };
		if (url.endsWith('klevu-16884958633259895.json')) return { ok: true, status: 200, json: async () => klevuConfig };
		const u = new URL(url);
		const term = u.searchParams.get('term');
		const from = Number(u.searchParams.get('paginationStartsFrom'));
		const status = statusFor(term, calls.length);
		if (status !== 200) return { ok: false, status, json: async () => ({}) };
		if (term === 'Bestop') return { ok: true, status: 200, json: async () => (from === 0 ? page0 : page1) };
		if (term === 'Covercraft') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: covercraftTotal, typeOfQuery: 'WILDCARD_AND' }, result: [{ id: '7', sku: 'Covercraft-C16928D4', name: 'Covercraft C16928D4 - Car Cover', price: '500.00', salePrice: '500.00', oldPrice: '500.00', currency: 'CAD', url: 'u', inStock: 'yes' }] }) };
		if (term === 'Covercraft C18001') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 1, typeOfQuery: 'FUZZY_AND' }, result: [{ id: '1', sku: 'Covercraft-C18001', name: 'Covercraft C18001 - Car Cover', price: '99.00', salePrice: '99.00', oldPrice: '99.00', currency: 'CAD', url: 'https://www.tdotperformance.ca/products/c18001', inStock: 'yes' }] }) };
		return { ok: true, status: 200, json: async () => fuzzy };
	};
	return { fetch, calls };
}

const run = (fetch, over = {}) => {
	const { config: configOverride, ...rest } = over;
	return collectTdot({ fetch, config: { ...config, ...(configOverride || {}) }, targets, labels: ['Bestop', 'Covercraft', 'Smittybilt'], runId: 9, logger: silent, sleep: noSleep, now, withRetry: noRetry, withConcurrency, random: () => 0, ...rest });
};

test('labelOfProduct strips the searchable sku from the tdot_code', () => {
	assert.strictEqual(labelOfProduct({ tdot_code: 'Rugged Ridge 11540.13', searchable_sku: '11540.13' }), 'Rugged Ridge');
	assert.strictEqual(labelOfProduct({ tdot_code: 'Bestop 52401-11', searchable_sku: 'other' }), 'Bestop', 'falls back to the first word');
	assert.strictEqual(labelOfProduct({ tdot_code: '', searchable_sku: 'x' }), null);
});

test('crawls small labels, queries huge labels per product, matches by canonical tdot_code and builds the payload', async () => {
	const { fetch, calls } = makeFetch();
	const { payload, stats } = await run(fetch);
	assert.strictEqual(payload.schemaVersion, 1);
	assert.strictEqual(payload.source, 'tdot');
	assert.strictEqual(payload.runId, 9);
	assert.strictEqual(payload.capturedAt, '2026-10-02T06:43:00.000Z');
	assert.deepStrictEqual(payload.items.map((i) => [i.tdotCode, i.productSku, i.effectivePrice]).sort(), [
		['Bestop 42811-01', 'BST-42811-01', 273.98],
		['Bestop 52401-11', 'BST-52401-11', 343.98],
		['Bestop 99999-01', 'BST-99999-01', 150],
		['Covercraft C18001', 'COV-C18001', 99],
	]);
	// storefront + config + 2 probes (Bestop, Covercraft) + 2 Bestop pages + 1 per-product Covercraft query
	assert.strictEqual(calls.length, 7, calls.map((c) => c.url).join('\n'));
	assert.deepStrictEqual(payload.labelStats.map((l) => [l.label, l.mode, l.requests, l.matched]), [
		['Bestop', 'crawl', 2, 3],
		['Covercraft', 'per-product', 1, 1],
	]);
	assert.strictEqual(payload.collection.requests, 5, 'probes and pages, not the discovery calls');
	assert.strictEqual(payload.collection.failedRequests, 0);
	assert.strictEqual(payload.collection.configSource, 'page');
	assert.strictEqual(payload.collection.partial, false);
	assert.strictEqual(payload.collection.invalidCount, 1, 'the record without a price');
	assert.strictEqual(payload.labelStats.find((l) => l.label === 'Bestop').unmatched, 6, 'Bestop records we do not sell');
	assert.strictEqual(stats.matched, 4);
	assert.ok(calls.every((c) => c.headers['user-agent'] === 'test-ua'));
});

test('labels without any of our products are never queried', async () => {
	const { fetch, calls } = makeFetch();
	await run(fetch);
	assert.ok(!calls.some((c) => c.url.includes('term=Smittybilt')));
});

test('a failing request is recorded with its code and the run continues; retryable errors go through withRetry', async () => {
	let attempts = 0;
	const retrying = async (fn) => { attempts += 1; try { return await fn(); } catch (e) { if (!e.retryable) throw e; return fn(); } };
	const { fetch } = makeFetch({ statusFor: (term, n) => (term === 'Covercraft C18001' ? 404 : 200) });
	const { payload } = await run(fetch, { withRetry: retrying });
	assert.strictEqual(payload.collection.failedRequests, 1);
	assert.deepStrictEqual(payload.failures.map((f) => [f.label, f.term, f.code, f.status]), [['Covercraft', 'Covercraft C18001', 'TDOT_HTTP_ERROR', 404]]);
	assert.strictEqual(payload.items.length, 3, 'the Bestop rows are still there');
	assert.ok(attempts >= 5);
});

test('the canaries abort the run before any payload when too much failed', async () => {
	const { fetch } = makeFetch({ statusFor: (term) => (term === 'Bestop' ? 500 : 200) });
	await assert.rejects(run(fetch, { config: { thresholds: { minMatched: 1, maxFailedRequestRatio: 0.1, maxInvalidRatio: 0.5 } } }),
		(e) => e instanceof TdotCollectError && e.failures.map((f) => f.code).includes('REQUEST_FAILED_RATIO'));
});

test('the request budget marks labels over budget and the payload is partial', async () => {
	const { fetch, calls } = makeFetch();
	const { payload } = await run(fetch, { config: { maxRequests: 3 } });
	assert.strictEqual(payload.collection.partial, true);
	assert.ok(payload.labelStats.some((l) => l.mode === 'over-budget'));
	assert.ok(calls.length < 7);
});

test('the time budget stops the crawl cleanly, marks the payload partial and the labels over-budget', async () => {
	let t = 0;
	const clock = () => new Date(Date.UTC(2026, 9, 2, 6, 43, 0) + (t += 61 * 60 * 1000));
	const { fetch } = makeFetch();
	const { payload } = await run(fetch, { now: clock, config: { maxRunMinutes: 1, thresholds: { minMatched: 0, maxFailedRequestRatio: 0.5, maxInvalidRatio: 0.5 } } });
	assert.strictEqual(payload.collection.partial, true);
	assert.strictEqual(payload.collection.labelsOverBudget, 2);
	assert.strictEqual(payload.collection.labelsProbeFailed, 0, 'a budget stop is not a probe failure');
	assert.ok(payload.collection.requests < 5);
});

test('a dev label limit caps how many labels are planned', async () => {
	const { fetch, calls } = makeFetch();
	const { payload } = await run(fetch, { config: { labelLimit: 1 } });
	assert.strictEqual(payload.labelStats.length, 1);
	assert.ok(!calls.some((c) => c.url.includes('term=Covercraft')));
});

test('the delay is awaited between requests', async () => {
	const sleeps = [];
	const { fetch } = makeFetch();
	await run(fetch, { sleep: async (ms) => { sleeps.push(ms); }, config: { requestDelayMs: 700 } });
	assert.ok(sleeps.length >= 4, `expected a sleep per request, got ${sleeps.length}`);
	assert.ok(sleeps.every((ms) => ms >= 700));
});

// TDOT's own brand token can differ from our label ("Fox Racing" vs
// "FoxShox"): the token search returned 880 items, the label 233 (2026-10-02).
test('when the probe shows a different brand token, the token is probed too and the bigger one is crawled', async () => {
	const fox = (sku) => ({ id: sku, sku, name: `${sku.replace('-', ' ')} - Shock`, price: '10.00', salePrice: '10.00', oldPrice: '10.00', currency: 'CAD', url: 'u', inStock: 'yes' });
	const calls = [];
	const fetch = async (url, opts = {}) => {
		calls.push(url);
		if (url === config.storefrontUrl) return { ok: true, status: 200, text: async () => html };
		if (url.endsWith('klevu-16884958633259895.json')) return { ok: true, status: 200, json: async () => klevuConfig };
		const term = new URL(url).searchParams.get('term');
		if (term === 'Fox Racing') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 2, typeOfQuery: 'WILDCARD_AND' }, result: [fox('FoxShox-1')] }) };
		if (term === 'FoxShox') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 3, typeOfQuery: 'WILDCARD_AND' }, result: [fox('FoxShox-1'), fox('FoxShox-2'), fox('FoxShox-3')] }) };
		return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 0 }, result: [] }) };
	};
	const foxTargets = [1, 2, 3, 4].map((n) => ({ sku: `FOX-${n}`, searchable_sku: String(n), tdot_code: `Fox Racing ${n}`, status: 1 }));
	const { payload } = await collectTdot({ fetch, config: { ...config, pageSize: 100, thresholds: { ...config.thresholds, minMatched: 0 } }, targets: foxTargets, labels: ['Fox Racing'], runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry, withConcurrency, random: () => 0 });
	const terms = calls.filter((u) => u.includes('cloud-search')).map((u) => new URL(u).searchParams.get('term'));
	assert.deepStrictEqual(terms, ['Fox Racing', 'FoxShox', 'FoxShox'], 'label probe, token probe, then the crawl with the token');
	const [foxStat] = payload.labelStats;
	assert.deepStrictEqual({ label: foxStat.label, mode: foxStat.mode, total: foxStat.total, requests: foxStat.requests, matched: foxStat.matched, term: foxStat.term, ourProducts: foxStat.ourProducts }, { label: 'Fox Racing', mode: 'crawl', total: 3, requests: 1, matched: 0, term: 'FoxShox', ourProducts: 4 });
	assert.strictEqual(payload.collection.requests, 3);
});

// TDOT does not sell every brand we label: the probe for "Corbeau Seats" came
// back with Sparco items (57,303 of them). Querying 481 products one by one
// for nothing is waste: a label whose probe shows no item of that brand is
// marked not-on-tdot and skipped.
test('a label whose probe shows none of its own items is skipped as not-on-tdot', async () => {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		if (url === config.storefrontUrl) return { ok: true, status: 200, text: async () => html };
		if (url.endsWith('klevu-16884958633259895.json')) return { ok: true, status: 200, json: async () => klevuConfig };
		const term = new URL(url).searchParams.get('term');
		const sparco = (n) => ({ id: String(n), sku: `Sparco-BPR000${n}`, name: `Sparco BPR000${n} - Seat`, price: '10', salePrice: '10', oldPrice: '10', currency: 'CAD', url: 'u', inStock: 'yes' });
		if (term === 'Corbeau Seats') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 57303, typeOfQuery: 'WILDCARD_AND' }, result: [sparco(1), sparco(2)] }) };
		if (term === 'Sparco') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 900, typeOfQuery: 'WILDCARD_AND' }, result: [sparco(1), sparco(2), sparco(3)] }) };
		return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 0 }, result: [] }) };
	};
	const corbeau = [1, 2, 3].map((n) => ({ sku: `CRB-${n}`, searchable_sku: String(n), tdot_code: `Corbeau Seats ${n}`, status: 1 }));
	const { payload } = await collectTdot({ fetch, config: { ...config, thresholds: { ...config.thresholds, minMatched: 0 } }, targets: corbeau, labels: ['Corbeau Seats'], runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry, withConcurrency, random: () => 0 });
	assert.deepStrictEqual(payload.labelStats.map((l) => [l.label, l.mode, l.requests]), [['Corbeau Seats', 'not-on-tdot', 0]]);
	assert.strictEqual(calls.filter((u) => u.includes('cloud-search')).length, 1, 'the foreign token (Sparco) is not even probed');
	assert.strictEqual(payload.collection.labelsNotOnTdot, 1);
	assert.deepStrictEqual(payload.labelStats[0].probeSample, ['Sparco BPR0001', 'Sparco BPR0002']);
});

// "N-Fab-75051" splits into the token "N": one letter is not a brand. The
// label stays and the label crawls as itself.
test('a one-letter brand token from a hyphenated brand is ignored', async () => {
	const calls = [];
	const nfab = (n) => ({ id: String(n), sku: `N-Fab-7505${n}`, name: `N-Fab 7505${n} - Step`, price: '10', salePrice: '10', oldPrice: '10', currency: 'CAD', url: 'u', inStock: 'yes' });
	const fetch = async (url) => {
		calls.push(url);
		if (url === config.storefrontUrl) return { ok: true, status: 200, text: async () => html };
		if (url.endsWith('klevu-16884958633259895.json')) return { ok: true, status: 200, json: async () => klevuConfig };
		const term = new URL(url).searchParams.get('term');
		if (term === 'N-Fab') return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 2, typeOfQuery: 'WILDCARD_AND' }, result: [nfab(1), nfab(2)] }) };
		return { ok: true, status: 200, json: async () => ({ meta: { totalResultsFound: 44479, typeOfQuery: 'WILDCARD_AND' }, result: [{ id: 'x', sku: 'Nitto-1', name: 'Nitto 1 - Tire', price: '1', salePrice: '1', oldPrice: '1', currency: 'CAD', url: 'u', inStock: 'yes' }] }) };
	};
	const targets = [1, 2].map((n) => ({ sku: `NFB-7505${n}`, searchable_sku: `7505${n}`, tdot_code: `N-Fab 7505${n}`, status: 1 }));
	const { payload } = await collectTdot({ fetch, config: { ...config, pageSize: 100, thresholds: { ...config.thresholds, minMatched: 0 } }, targets, labels: ['N-Fab'], runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry, withConcurrency, random: () => 0 });
	const terms = calls.filter((u) => u.includes('cloud-search')).map((u) => new URL(u).searchParams.get('term'));
	assert.deepStrictEqual(terms, ['N-Fab', 'N-Fab'], 'probe and crawl with the label; no "N" probe');
	assert.strictEqual(payload.labelStats[0].mode, 'crawl');
	assert.strictEqual(payload.labelStats[0].matched, 2);
});

// The real withRetry retries on any throw; a definitive error (404, bad
// body) must not be retried, and every HTTP attempt must be counted.
test('a definitive error is fetched once with the real withRetry and attempts are counted', async () => {
	const { withRetry } = require('../../../../lib/ingest/withRetry');
	const { fetch, calls } = makeFetch({ statusFor: (term) => (term === 'Covercraft C18001' ? 404 : 200) });
	const { payload } = await run(fetch, { withRetry });
	const hits = calls.filter((c) => c.url.includes('Covercraft+C18001') || c.url.includes('Covercraft%20C18001'));
	assert.strictEqual(hits.length, 1, 'a 404 is not retried');
	assert.strictEqual(payload.collection.failedRequests, 1);
	assert.strictEqual(payload.collection.httpAttempts, payload.collection.requests);
});

test('ten consecutive failed requests trip the circuit breaker before the budget is burnt', async () => {
	const { fetch, calls } = makeFetch({ statusFor: () => 503 });
	await assert.rejects(run(fetch, { config: { consecutiveFailureLimit: 2, thresholds: { minMatched: 0, maxFailedRequestRatio: 1, maxInvalidRatio: 1 } } }), (e) => e.code === 'TDOT_SOURCE_UNAVAILABLE');
	assert.strictEqual(calls.filter((c) => c.url.includes('cloud-search')).length, 2);
});

test('the time budget expiring during the probes reports labels as over-budget, not probe-failed, and keeps the floor', async () => {
	let t = 0;
	const clock = () => new Date(Date.UTC(2026, 9, 2, 6, 43, 0) + (t += 61 * 60 * 1000));
	const { fetch } = makeFetch();
	await assert.rejects(run(fetch, { now: clock, config: { maxRunMinutes: 1, thresholds: { minMatched: 1, maxFailedRequestRatio: 0.5, maxInvalidRatio: 0.5 } } }),
		(e) => e instanceof TdotCollectError && e.failures.map((f) => f.code).includes('BELOW_MIN_MATCHED'));
});

test('the payload carries per-label coverage and samples for the audit, and items keep the price fields', async () => {
	const { fetch } = makeFetch();
	const { payload } = await run(fetch);
	const bestop = payload.labelStats.find((l) => l.label === 'Bestop');
	assert.strictEqual(bestop.ourProducts, 4);
	assert.strictEqual(bestop.unmatched, 6);
	assert.strictEqual(bestop.unmatchedSample.length, 5);
	assert.ok(bestop.probeSample.length >= 1);
	const item = payload.items.find((i) => i.tdotCode === 'Bestop 99999-01');
	assert.deepStrictEqual({ oldPrice: item.oldPrice, sourceId: item.sourceId, rawPrice: item.rawPrice }, { oldPrice: 200, sourceId: '999001', rawPrice: { price: '200.00', salePrice: '150.00', oldPrice: '200.00' } });
	assert.strictEqual(payload.collection.perProductResults, 20);
});

test('labels run two at a time when concurrency is 2, and the per-worker delay is still awaited', async () => {
	let inFlight = 0; let peak = 0;
	const base = makeFetch();
	const fetch = async (url, opts) => { inFlight += 1; peak = Math.max(peak, inFlight); const r = await base.fetch(url, opts); await new Promise((res) => setTimeout(res, 2)); inFlight -= 1; return r; };
	const sleeps = [];
	await run(fetch, { sleep: async (ms) => { sleeps.push(ms); }, config: { concurrency: 2, requestDelayMs: 100 } });
	assert.ok(peak >= 2, `expected two labels in flight, peak was ${peak}`);
	assert.ok(sleeps.length >= 4);
});

test('the payload records how long each phase and each label took, for the run audit', async () => {
	let t = 0;
	const clock = () => new Date(Date.UTC(2026, 9, 2, 6, 43, 0) + (t += 1000));
	const { fetch } = makeFetch();
	const { payload } = await run(fetch, { now: clock });
	const timing = payload.collection.timing;
	for (const key of ['discoverMs', 'probeMs', 'fetchMs', 'matchMs']) assert.strictEqual(typeof timing[key], 'number', key);
	assert.ok(timing.probeMs > 0 && timing.fetchMs > 0);
	assert.ok(payload.collection.durationMs >= timing.discoverMs + timing.probeMs + timing.fetchMs + timing.matchMs);
	const bestop = payload.labelStats.find((l) => l.label === 'Bestop');
	assert.ok(bestop.durationMs > 0, 'a crawled label carries its fetch time');
	assert.ok(payload.labelStats.every((l) => typeof l.durationMs === 'number'));
});
