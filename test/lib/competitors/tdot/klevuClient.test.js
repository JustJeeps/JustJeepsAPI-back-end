const test = require('node:test');
const assert = require('node:assert');

const { createKlevuClient, buildSearchUrl } = require('../../../../lib/competitors/tdot/klevuClient');
const page0 = require('./fixtures/klevu-bestop-page0.json');

const base = { apiKey: 'klevu-16884958633259895', searchDomain: 'uscs32.ksearchnet.com', userAgent: 'test-ua', timeoutMs: 1000 };

function makeFetch(handler) {
	const calls = [];
	const fetch = async (url, opts = {}) => {
		calls.push({ url, headers: opts.headers || {} });
		return handler(url, calls.length);
	};
	return { fetch, calls };
}

test('buildSearchUrl asks the cloud endpoint the way the storefront does, capped at 100 results', () => {
	const url = new URL(buildSearchUrl({ ...base, term: 'Rugged Ridge 11540.13', noOfResults: 100, paginationStartsFrom: 200 }));
	assert.strictEqual(url.origin + url.pathname, 'https://uscs32.ksearchnet.com/cloud-search/n-search/search');
	assert.strictEqual(url.searchParams.get('ticket'), 'klevu-16884958633259895');
	assert.strictEqual(url.searchParams.get('term'), 'Rugged Ridge 11540.13');
	assert.strictEqual(url.searchParams.get('noOfResults'), '100');
	assert.strictEqual(url.searchParams.get('paginationStartsFrom'), '200');
	assert.strictEqual(url.searchParams.get('responseType'), 'json');
	assert.strictEqual(url.searchParams.get('klevuShowOutOfStockProducts'), 'true');
	assert.strictEqual(url.searchParams.get('klevuSort'), 'rel');
	assert.strictEqual(new URL(buildSearchUrl({ ...base, term: 'x', noOfResults: 500 })).searchParams.get('noOfResults'), '100');
});

test('search returns the records, the total and the query type, sending our User-Agent', async () => {
	const { fetch, calls } = makeFetch(async () => ({ ok: true, status: 200, json: async () => page0 }));
	const client = createKlevuClient({ fetch, ...base });
	const page = await client.search({ term: 'Bestop', paginationStartsFrom: 0, noOfResults: 100 });
	assert.strictEqual(page.records.length, 5);
	assert.strictEqual(page.total, 8);
	assert.strictEqual(page.typeOfQuery, 'WILDCARD_AND');
	assert.strictEqual(calls[0].headers['user-agent'], 'test-ua');
	assert.strictEqual(calls[0].headers.accept, 'application/json');
});

test('search describes failures with a code and never puts the key in the message', async () => {
	const key = base.apiKey;
	let client = createKlevuClient({ fetch: makeFetch(async () => { throw new Error('socket hang up'); }).fetch, ...base });
	await assert.rejects(client.search({ term: 'x' }), (e) => e.code === 'TDOT_FETCH_FAILED' && !e.message.includes(key));
	client = createKlevuClient({ fetch: makeFetch(async () => ({ ok: false, status: 429, json: async () => ({}) })).fetch, ...base });
	await assert.rejects(client.search({ term: 'x' }), (e) => e.code === 'TDOT_HTTP_ERROR' && e.status === 429 && e.retryable === true && !e.message.includes(key));
	client = createKlevuClient({ fetch: makeFetch(async () => ({ ok: false, status: 404, json: async () => ({}) })).fetch, ...base });
	await assert.rejects(client.search({ term: 'x' }), (e) => e.code === 'TDOT_HTTP_ERROR' && e.retryable === false);
	client = createKlevuClient({ fetch: makeFetch(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) })).fetch, ...base });
	await assert.rejects(client.search({ term: 'x' }), (e) => e.code === 'TDOT_BAD_BODY');
	client = createKlevuClient({ fetch: makeFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })).fetch, ...base });
	await assert.rejects(client.search({ term: 'x' }), (e) => e.code === 'TDOT_BAD_BODY');
});
