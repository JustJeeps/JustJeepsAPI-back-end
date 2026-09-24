const test = require('node:test');
const assert = require('node:assert');

const { createMagentoProductInfoClient, parseMagentoProduct } = require('../../../lib/magento/productInfoClient');

// Minimal shape of GET /rest/default/V1/products?searchCriteria[...] items.
const magentoItem = (sku, overrides = {}) => ({
	sku,
	name: `Name of ${sku}`,
	media_gallery_entries: [{ file: `/a/b/${sku.toLowerCase()}.jpg`, disabled: false, types: ['image'] }],
	custom_attributes: [
		{ attribute_code: 'url_key', value: `${sku.toLowerCase()}-page` },
		{ attribute_code: 'short_description', value: '<p>Short <b>desc</b> of the part.</p>' },
		{ attribute_code: 'description', value: '<div>Long description</div>' },
	],
	...overrides,
});

const makeHttp = (handler) => {
	const calls = [];
	return {
		calls,
		get: async (url, config) => {
			calls.push({ url, config });
			return handler(url, config, calls.length);
		},
	};
};

const skusInUrl = (url) => decodeURIComponent(url).match(/\[value\]=([^&]+)/)[1].split(',');
const answerAll = async (url) => ({ data: { items: skusInUrl(url).map((sku) => magentoItem(sku)) } });
const quietLogger = () => ({ warn() {}, error() {}, info() {} });
const recordingLogger = () => {
	const lines = { warn: [], error: [], info: [] };
	return { lines, warn: (...a) => lines.warn.push(a), error: (...a) => lines.error.push(a), info: (...a) => lines.info.push(a) };
};

const ENV = { MAGENTO_KEY: 'secret-token', MAGENTO_BASE_URL: 'https://www.justjeeps.com' };

test('parseMagentoProduct builds image, page url and a plain-text description', () => {
	const parsed = parseMagentoProduct(magentoItem('CRO-83503077'), 'https://www.justjeeps.com');
	assert.deepStrictEqual(parsed, {
		sku: 'CRO-83503077',
		name: 'Name of CRO-83503077',
		description: 'Short desc of the part.',
		image: 'https://www.justjeeps.com/pub/media/catalog/product/a/b/cro-83503077.jpg',
		url_path: 'https://www.justjeeps.com/cro-83503077-page.html',
	});
});

test('parseMagentoProduct falls back to the long description and tolerates missing gallery and url', () => {
	const parsed = parseMagentoProduct({
		sku: 'X-1',
		name: 'X',
		custom_attributes: [{ attribute_code: 'description', value: 'Only &amp; long   text' }],
	}, 'https://www.justjeeps.com');
	assert.strictEqual(parsed.description, 'Only & long text');
	assert.strictEqual(parsed.image, null);
	assert.strictEqual(parsed.url_path, null);
});

test('getProductsBySkus asks Magento once for a list of SKUs and returns them by sku, not degraded', async () => {
	const http = makeHttp(async () => ({ data: { items: [magentoItem('A-1'), magentoItem('B-2')] } }));
	const client = createMagentoProductInfoClient({ http, env: ENV, logger: quietLogger() });

	const result = await client.getProductsBySkus(['A-1', ' B-2 ', 'A-1']);

	assert.strictEqual(http.calls.length, 1);
	const { url, config } = http.calls[0];
	assert.ok(url.startsWith('https://www.justjeeps.com/rest/default/V1/products?'), url);
	assert.match(url, /condition_type%5D=in|condition_type\]=in/);
	assert.match(decodeURIComponent(url), /\[value\]=A-1,B-2/);
	assert.ok(!url.includes('fields='), 'no fields projection: unverified against the real store');
	assert.strictEqual(config.headers.Authorization, 'Bearer secret-token');
	assert.strictEqual(config.timeout, 5000, 'interactive timeout, not the seed one');
	assert.deepStrictEqual([...result.products.keys()], ['A-1', 'B-2']);
	assert.strictEqual(result.products.get('B-2').name, 'Name of B-2');
	assert.strictEqual(result.degraded, false);
});

test('getProductsBySkus caches answers and only asks Magento for unknown SKUs', async () => {
	const http = makeHttp(answerAll);
	const client = createMagentoProductInfoClient({ http, env: ENV, logger: quietLogger() });

	await client.getProductsBySkus(['A-1']);
	const second = await client.getProductsBySkus(['A-1', 'C-3']);

	assert.strictEqual(http.calls.length, 2);
	assert.match(decodeURIComponent(http.calls[1].url), /\[value\]=C-3(&|$)/);
	assert.deepStrictEqual([...second.products.keys()].sort(), ['A-1', 'C-3']);
});

test('getProductsBySkus remembers a SKU Magento does not know, so it is not asked again', async () => {
	const http = makeHttp(async () => ({ data: { items: [] } }));
	const client = createMagentoProductInfoClient({ http, env: ENV, logger: quietLogger() });
	assert.strictEqual((await client.getProductsBySkus(['NOPE'])).products.size, 0);
	assert.strictEqual((await client.getProductsBySkus(['NOPE'])).products.size, 0);
	assert.strictEqual(http.calls.length, 1);
});

test('getProductsBySkus chunks large lists and runs the chunks concurrently', async () => {
	const http = makeHttp(answerAll);
	const client = createMagentoProductInfoClient({ http, env: ENV, logger: quietLogger(), batchSize: 2 });
	const result = await client.getProductsBySkus(['A', 'B', 'C']);
	assert.strictEqual(http.calls.length, 2);
	assert.strictEqual(result.products.size, 3);
});

test('an HTTP failure returns what it has, is degraded, logs without the token and does not throw', async () => {
	const logger = recordingLogger();
	const http = makeHttp(async () => {
		const error = new Error('Request failed with status code 503');
		error.isAxiosError = true;
		error.response = { status: 503, data: { message: 'down' } };
		error.config = { headers: { Authorization: 'Bearer secret-token' } };
		throw error;
	});
	const client = createMagentoProductInfoClient({ http, env: ENV, logger, cooldownMs: 0 });
	const result = await client.getProductsBySkus(['A-1']);
	assert.strictEqual(result.products.size, 0);
	assert.strictEqual(result.degraded, true);
	assert.strictEqual(logger.lines.warn.length, 1);
	assert.ok(!JSON.stringify(logger.lines.warn).includes('secret-token'), 'token must never reach the logs');
	assert.strictEqual(logger.lines.error.length, 0, 'an outage is a warning, not an error');
	// A failure is not cached: with no cooldown the next call asks again.
	await client.getProductsBySkus(['A-1']);
	assert.strictEqual(http.calls.length, 2);
});

test('a 200 without an items array is a failure: logged with the body head, nothing cached, next call retries', async () => {
	const logger = recordingLogger();
	let calls = 0;
	const http = makeHttp(async () => {
		calls += 1;
		if (calls === 1) return { status: 200, headers: { 'content-type': 'text/html' }, data: '<html><body>Site under maintenance</body></html>' };
		return { data: { items: [magentoItem('A-1')] } };
	});
	const client = createMagentoProductInfoClient({ http, env: ENV, logger, cooldownMs: 0 });

	const first = await client.getProductsBySkus(['A-1']);
	assert.strictEqual(first.products.size, 0);
	assert.strictEqual(first.degraded, true);
	assert.strictEqual(logger.lines.warn.length, 1);
	const logged = JSON.stringify(logger.lines.warn[0]);
	assert.match(logged, /MAGENTO_UNEXPECTED_RESPONSE/);
	assert.match(logged, /text\/html/);
	assert.match(logged, /Site under maintenance/);

	const second = await client.getProductsBySkus(['A-1']);
	assert.strictEqual(http.calls.length, 2, 'the unexpected body must not be negatively cached');
	assert.strictEqual(second.products.get('A-1').name, 'Name of A-1');
	assert.strictEqual(second.degraded, false);
});

test('a parser error is logged at error level with its stack and still falls back', async () => {
	const logger = recordingLogger();
	const poison = { get sku() { throw new Error('parser boom'); } };
	const http = makeHttp(async () => ({ data: { items: [poison] } }));
	const client = createMagentoProductInfoClient({ http, env: ENV, logger, cooldownMs: 0 });
	const result = await client.getProductsBySkus(['A-1']);
	assert.strictEqual(result.products.size, 0);
	assert.strictEqual(result.degraded, true);
	assert.strictEqual(logger.lines.error.length, 1);
	assert.match(JSON.stringify(logger.lines.error[0]), /parser boom/);
	assert.match(JSON.stringify(logger.lines.error[0]), /stack/);
	assert.strictEqual(logger.lines.warn.length, 0);
});

test('a failure opens a cooldown: calls inside it make no request, the first call after it retries', async () => {
	let nowMs = 10000;
	const logger = recordingLogger();
	let fail = true;
	const http = makeHttp(async (url) => {
		if (fail) { const error = new Error('timeout of 5000ms exceeded'); error.isAxiosError = true; error.code = 'ECONNABORTED'; throw error; }
		return answerAll(url);
	});
	const client = createMagentoProductInfoClient({ http, env: ENV, logger, now: () => nowMs, cooldownMs: 60000 });

	assert.strictEqual((await client.getProductsBySkus(['A-1'])).degraded, true);
	assert.strictEqual(http.calls.length, 1);
	nowMs += 30000;
	const inside = await client.getProductsBySkus(['B-2']);
	assert.strictEqual(http.calls.length, 1, 'no request while the cooldown is open');
	assert.strictEqual(inside.degraded, true);
	assert.strictEqual(inside.products.size, 0);
	fail = false;
	nowMs += 31000;
	const after = await client.getProductsBySkus(['B-2']);
	assert.strictEqual(http.calls.length, 2, 'retries once the cooldown expired');
	assert.strictEqual(after.degraded, false);
	assert.strictEqual(after.products.get('B-2').name, 'Name of B-2');
	const infoText = JSON.stringify(logger.lines.info);
	assert.match(infoText, /cooldown/i);
});

test('batches stop after the first failed wave', async () => {
	const http = makeHttp(async () => { const error = new Error('boom'); error.isAxiosError = true; throw error; });
	const client = createMagentoProductInfoClient({ http, env: ENV, logger: quietLogger(), batchSize: 1, concurrency: 2, cooldownMs: 0 });
	const result = await client.getProductsBySkus(['A', 'B', 'C', 'D', 'E']);
	assert.strictEqual(http.calls.length, 2, 'only the first wave of 2 batches was sent');
	assert.strictEqual(result.degraded, true);
});

test('without MAGENTO_KEY the client is not configured, never calls the API and reports degraded', async () => {
	const http = makeHttp(async () => { throw new Error('should not be called'); });
	const client = createMagentoProductInfoClient({ http, env: {}, logger: quietLogger() });
	assert.strictEqual(client.isConfigured(), false);
	const result = await client.getProductsBySkus(['A-1']);
	assert.strictEqual(result.products.size, 0);
	assert.strictEqual(result.degraded, true);
	assert.strictEqual(http.calls.length, 0);
});

test('cache entries expire after the ttl and the cache is capped', async () => {
	let nowMs = 1000;
	const http = makeHttp(answerAll);
	const client = createMagentoProductInfoClient({ http, env: ENV, logger: quietLogger(), ttlMs: 500, now: () => nowMs, maxCacheEntries: 2 });
	await client.getProductsBySkus(['A-1']);
	nowMs = 1400;
	await client.getProductsBySkus(['A-1']);
	assert.strictEqual(http.calls.length, 1);
	nowMs = 1600;
	await client.getProductsBySkus(['A-1']);
	assert.strictEqual(http.calls.length, 2);
	await client.getProductsBySkus(['B-2', 'C-3', 'D-4']);
	assert.ok(client.cacheSize() <= 2, `cache capped, got ${client.cacheSize()}`);
});
