const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { collectLowriders, LowridersCollectError } = require('../../../lib/competitors/lowriders/collect');
const { createPartslogicClient } = require('../../../lib/competitors/lowriders/partslogicClient');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/brand-page.html'), 'utf8');
const fixture = require('./fixtures/products-page.json');
const silent = { info() {}, warn() {}, error() {} };
const noRetry = async (fn) => fn();
const noSleep = async () => {};
const now = () => new Date('2026-09-18T07:13:00.000Z');

const config = {
	brandPageUrl: 'https://www.lowriders.ca/b-90296-rough-country.html?facet-brands=90296',
	apiBaseUrl: 'https://api.sunhammer.io',
	brandId: 90296, pageSize: 2, pageDelayMs: 0, timeoutMs: 1000, userAgent: 'test-ua', fallbackApiKey: '',
	maxPrice: 20000,
	thresholds: { minItems: 3, minCollectRatio: 0.9 },
};

// Serves the brand page and N API pages, records every call.
function makeFetch({ pages, pageStatus = () => 200, total = 4 }) {
	const calls = [];
	const fetch = async (url, opts = {}) => {
		calls.push({ url, headers: opts.headers || {} });
		if (url.startsWith(config.brandPageUrl)) return { ok: true, status: 200, text: async () => html };
		const page = Number(new URL(url).searchParams.get('page'));
		const status = pageStatus(page, calls.length);
		if (status !== 200) return { ok: false, status, json: async () => ({ message: 'nope' }) };
		return { ok: true, status: 200, json: async () => ({ list: pages[page - 1] || [], total }) };
	};
	return { fetch, calls };
}

test('client sends the key header and rejects a 404', async () => {
	const FAKE_KEY = 'fake-key-0123456789abcdef';
	const { fetch, calls } = makeFetch({ pages: [fixture.list], pageStatus: () => 404 });
	const client = createPartslogicClient({ fetch, apiKey: FAKE_KEY, baseUrl: config.apiBaseUrl, userAgent: 'ua', timeoutMs: 1000 });
	await assert.rejects(client.fetchPage({ brandId: 90296, page: 1, limit: 2 }), (e) => e.code === 'LOWRIDERS_KEY_REJECTED' && !e.message.includes(FAKE_KEY));
	assert.strictEqual(calls[0].headers['sunhammer-api-key'], FAKE_KEY);
	assert.match(calls[0].url, /brands=90296&limit=2&page=1/);
});

test('client asks for a stable order: the default "Recommended" order shifts between pages', async () => {
	// Verified 2026-09-18 in production: without sort, 7763 raw items held only
	// 6134 unique stockids across 16 pages; with sort=id:asc, 7763 of 7763.
	const { fetch, calls } = makeFetch({ pages: [fixture.list] });
	const client = createPartslogicClient({ fetch, apiKey: 'k', baseUrl: config.apiBaseUrl, userAgent: 'ua', timeoutMs: 1000 });
	await client.fetchPage({ brandId: 90296, page: 1, limit: 2 });
	assert.strictEqual(new URL(calls[0].url).searchParams.get('sort'), 'id:asc');
});

test('collects every page, normalizes and builds the payload', async () => {
	const [a, b, c, d] = fixture.list;
	const { fetch, calls } = makeFetch({ pages: [[a, b], [c, d]], total: 4 });
	const result = await collectLowriders({ fetch, config, runId: 7, logger: silent, sleep: noSleep, now, withRetry: noRetry, random: () => 0 });
	assert.strictEqual(result.payload.items.length, 4);
	assert.strictEqual(result.payload.collection.pagesFetched, 2);
	assert.strictEqual(result.payload.collection.reportedTotal, 4);
	assert.strictEqual(result.payload.collection.configSource, 'page');
	assert.strictEqual(result.payload.runId, 7);
	assert.strictEqual(result.payload.capturedAt, '2026-09-18T07:13:00.000Z');
	assert.strictEqual(calls.length, 3, 'brand page + 2 API pages');
	assert.strictEqual(calls[1].headers['sunhammer-api-key'], '11111111-2222-3333-4444-555555555555');
	assert.strictEqual(calls[1].headers['user-agent'], 'test-ua');
});

test('a short collection aborts before any payload with the canary codes', async () => {
	const { fetch } = makeFetch({ pages: [[fixture.list[0]]], total: 4 });
	await assert.rejects(
		collectLowriders({ fetch, config, runId: 7, logger: silent, sleep: noSleep, now, withRetry: noRetry }),
		(err) => err instanceof LowridersCollectError && err.failures.map((f) => f.code).includes('TOTAL_MISMATCH'),
	);
});

// Key rotated mid-day: the first 404 re-reads the brand page once and retries.
test('a 404 triggers exactly one re-discovery of the key, a second 404 fails', async () => {
	let apiHits = 0;
	const { fetch, calls } = makeFetch({ pages: [fixture.list.slice(0, 4)], total: 4, pageStatus: () => (apiHits++ === 0 ? 404 : 200) });
	const result = await collectLowriders({ fetch, config: { ...config, pageSize: 4 }, runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry });
	assert.strictEqual(result.payload.items.length, 4);
	assert.strictEqual(calls.filter((c) => c.url.startsWith(config.brandPageUrl)).length, 2, 'brand page read twice');

	const always404 = makeFetch({ pages: [fixture.list], total: 4, pageStatus: () => 404 });
	await assert.rejects(
		collectLowriders({ fetch: always404.fetch, config, runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry }),
		(e) => e.code === 'LOWRIDERS_KEY_REJECTED',
	);
});

test('stops at the reported total even when the last page is full', async () => {
	const { fetch, calls } = makeFetch({ pages: [fixture.list.slice(0, 2), fixture.list.slice(2, 4), [fixture.list[0]]], total: 4 });
	await collectLowriders({ fetch, config, runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry });
	assert.strictEqual(calls.filter((c) => c.url.includes('/products')).length, 2);
});
