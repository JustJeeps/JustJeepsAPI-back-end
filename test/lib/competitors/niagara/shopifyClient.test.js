const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createShopifyClient } = require('../../../../lib/competitors/niagara/shopifyClient');
const { createCookieJar } = require('../../../../lib/competitors/niagara/cookieJar');

const challengeHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'cf-challenge.html'), 'utf8');

function response({ status = 200, contentType = 'application/json', body = '', headers = {}, setCookie = [] }) {
	const all = new Headers({ 'content-type': contentType, ...headers });
	for (const line of setCookie) all.append('set-cookie', line);
	return { ok: status < 400, status, headers: all, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

function makeClient(handler, extra = {}) {
	const calls = [];
	const fetch = async (url, opts = {}) => {
		calls.push({ url, headers: opts.headers || {} });
		return handler(url, calls.length);
	};
	const client = createShopifyClient({ fetch, baseUrl: 'https://niagarajeeps.ca', userAgent: 'test-ua', timeoutMs: 1000, ...extra });
	return { client, calls };
}

const rejectsWith = (promise, code, extra = {}) => assert.rejects(promise, (err) => {
	assert.strictEqual(err.code, code);
	for (const [key, value] of Object.entries(extra)) assert.strictEqual(err[key], value);
	return true;
});

test('fetchCollectionPage asks the collection JSON with limit and page and returns the products', async () => {
	const { client, calls } = makeClient(() => response({ body: { products: [{ id: 1 }, { id: 2 }] } }));
	const page = await client.fetchCollectionPage({ handle: 'rough-country', page: 3, limit: 250 });
	assert.deepStrictEqual(page.products.map((p) => p.id), [1, 2]);
	assert.strictEqual(calls[0].url, 'https://niagarajeeps.ca/collections/rough-country/products.json?limit=250&page=3');
	assert.strictEqual(calls[0].headers['user-agent'], 'test-ua');
	assert.strictEqual(calls[0].headers.accept, 'application/json');
});

test('fetchCollectionsIndex returns the collections of one index page', async () => {
	const { client, calls } = makeClient(() => response({ body: { collections: [{ handle: 'bilstein', products_count: 589 }] } }));
	const page = await client.fetchCollectionsIndex(2);
	assert.strictEqual(page.collections[0].products_count, 589);
	assert.strictEqual(calls[0].url, 'https://niagarajeeps.ca/collections.json?limit=250&page=2');
});

test('fetchBrandPage returns the HTML of the shop-by-brand page', async () => {
	const { client, calls } = makeClient(() => response({ contentType: 'text/html', body: '<html>brands</html>' }));
	assert.strictEqual(await client.fetchBrandPage(), '<html>brands</html>');
	assert.strictEqual(calls[0].url, 'https://niagarajeeps.ca/pages/shop-by-brand');
});

test('the cookie jar is filled from Set-Cookie and resent on the next request', async () => {
	const jar = createCookieJar();
	const { client, calls } = makeClient(() => response({ body: { products: [] }, setCookie: ['__cf_bm=abc; path=/'] }), { jar });
	await client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 });
	await client.fetchCollectionPage({ handle: 'a', page: 2, limit: 250 });
	assert.strictEqual(calls[0].headers.cookie, undefined);
	assert.strictEqual(calls[1].headers.cookie, '__cf_bm=abc');
});

test('a challenge page is NIAGARA_CHALLENGED and not retryable', async () => {
	const { client } = makeClient(() => response({ status: 403, contentType: 'text/html', body: challengeHtml }));
	await rejectsWith(client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 }), 'NIAGARA_CHALLENGED', { retryable: false });
});

test('HTTP 429 is NIAGARA_RATE_LIMITED, retryable, with Retry-After in milliseconds', async () => {
	const { client } = makeClient(() => response({ status: 429, contentType: 'text/plain', headers: { 'retry-after': '60' } }));
	await rejectsWith(client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 }), 'NIAGARA_RATE_LIMITED', { retryable: true, retryAfterMs: 60000 });
});

test('the 25,000 page cap answer is NIAGARA_PAGE_CAP', async () => {
	const { client } = makeClient(() => response({ status: 400, body: { errors: 'Page * Limit exceeds the 25000 limit.' } }));
	await rejectsWith(client.fetchCollectionPage({ handle: 'a', page: 101, limit: 250 }), 'NIAGARA_PAGE_CAP', { retryable: false });
});

test('404 is NIAGARA_NOT_FOUND, 5xx is a retryable NIAGARA_HTTP_ERROR', async () => {
	const notFound = makeClient(() => response({ status: 404, body: { errors: 'Not Found' } }));
	await rejectsWith(notFound.client.fetchCollectionPage({ handle: 'gone', page: 1, limit: 250 }), 'NIAGARA_NOT_FOUND', { retryable: false, status: 404 });
	const down = makeClient(() => response({ status: 502, contentType: 'text/plain', body: 'bad gateway' }));
	await rejectsWith(down.client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 }), 'NIAGARA_HTTP_ERROR', { retryable: true, status: 502 });
});

test('a network error is a retryable NIAGARA_FETCH_FAILED', async () => {
	const { client } = makeClient(() => { throw new Error('socket hang up'); });
	await rejectsWith(client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 }), 'NIAGARA_FETCH_FAILED', { retryable: true });
});

test('JSON without a products array is NIAGARA_BAD_BODY', async () => {
	const { client } = makeClient(() => response({ body: { product: {} } }));
	await rejectsWith(client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 }), 'NIAGARA_BAD_BODY', { retryable: false });
	const broken = makeClient(() => response({ body: '{"products": [' }));
	await rejectsWith(broken.client.fetchCollectionPage({ handle: 'a', page: 1, limit: 250 }), 'NIAGARA_BAD_BODY');
});
