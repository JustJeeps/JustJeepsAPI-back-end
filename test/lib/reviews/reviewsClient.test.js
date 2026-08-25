const test = require('node:test');
const assert = require('node:assert');

const { createMagentoReviewsClient, resolveMagentoBaseUrl } = require('../../../lib/magento/reviewsClient');

// Molde test/lib/trelloClient.test.js: http stub injetado, sem rede.

const ENV = { MAGENTO_KEY: 'secret-token-123', MAGENTO_BASE_URL: 'https://www.justjeeps.com' };

function makeHttpStub(responder) {
	const calls = [];
	const record = async (method, url, dataOrConfig, maybeConfig) => {
		const config = method === 'get' ? dataOrConfig : maybeConfig;
		const data = method === 'get' ? undefined : dataOrConfig;
		calls.push({ method, url, data, config });
		return responder({ method, url, data, config });
	};
	return {
		calls,
		get: (url, config) => record('get', url, config),
		post: (url, data, config) => record('post', url, data, config),
	};
}

test('resolveMagentoBaseUrl: default sem www, corte do /rest/ e barra final', () => {
	assert.strictEqual(resolveMagentoBaseUrl({}), 'https://justjeeps.com');
	assert.strictEqual(
		resolveMagentoBaseUrl({ MAGENTO_BASE_URL: 'https://justjeeps.com/rest/default/V1' }),
		'https://justjeeps.com'
	);
	assert.strictEqual(
		resolveMagentoBaseUrl({ MAGENTO_BASE_URL: 'https://justjeeps.com/' }),
		'https://justjeeps.com'
	);
});

test('getReviewsBySku: URL com encodeURIComponent, Bearer no header e timeout', async () => {
	const http = makeHttpStub(async () => ({ status: 200, data: [{ nickname: 'A' }] }));
	const client = createMagentoReviewsClient({ http, env: { ...ENV, MAGENTO_REVIEWS_TIMEOUT_MS: '9000' } });

	const reviews = await client.getReviewsBySku('A B/C');

	assert.deepStrictEqual(reviews, [{ nickname: 'A' }]);
	const call = http.calls[0];
	assert.strictEqual(call.url, 'https://www.justjeeps.com/rest/default/V1/products/A%20B%2FC/reviews');
	assert.strictEqual(call.config.headers.Authorization, 'Bearer secret-token-123');
	assert.strictEqual(call.config.timeout, 9000);
});

test('timeout default e 120s (bulk lento em prod) e ignora o MAGENTO_TIMEOUT_MS global', async () => {
	const http = makeHttpStub(async () => ({ status: 200, data: [] }));
	const client = createMagentoReviewsClient({ http, env: { ...ENV, MAGENTO_TIMEOUT_MS: '15000' } });
	await client.getReviewsBySku('X');
	assert.strictEqual(http.calls[0].config.timeout, 120000);
});

test('getReviewsBySku desembrulha o shape real de prod { sku, review_count, reviews: [...] }', async () => {
	const wrapped = { sku: 'BAR-J214074', rating_summary: 0, review_count: 1, reviews: [{ nickname: 'A' }] };
	const http = makeHttpStub(async () => ({ status: 200, data: wrapped }));
	const client = createMagentoReviewsClient({ http, env: ENV });
	assert.deepStrictEqual(await client.getReviewsBySku('BAR-J214074'), [{ nickname: 'A' }]);

	// shape desconhecido passa adiante (o matchReview decide, nunca assume ausencia)
	const odd = makeHttpStub(async () => ({ status: 200, data: { foo: 'bar' } }));
	const client2 = createMagentoReviewsClient({ http: odd, env: ENV });
	assert.deepStrictEqual(await client2.getReviewsBySku('X'), { foo: 'bar' });
});

test('postReviewsBulk: body { reviews } no endpoint bulk', async () => {
	const http = makeHttpStub(async () => ({ status: 200, data: {} }));
	const client = createMagentoReviewsClient({ http, env: ENV });

	const result = await client.postReviewsBulk([{ sku: 'X', nickname: 'N' }]);

	assert.strictEqual(result.status, 200);
	const call = http.calls[0];
	assert.strictEqual(call.url, 'https://www.justjeeps.com/rest/default/V1/products/reviews/bulk');
	assert.deepStrictEqual(call.data, { reviews: [{ sku: 'X', nickname: 'N' }] });
});

const failWith = (error) => makeHttpStub(async () => { throw error; });

test('mapa de erros: 401 -> AUTH_FAILED com desfecho conhecido', async () => {
	const client = createMagentoReviewsClient({ http: failWith({ response: { status: 401 } }), env: ENV });
	await assert.rejects(client.postReviewsBulk([]), (error) => {
		assert.strictEqual(error.code, 'MAGENTO_AUTH_FAILED');
		assert.strictEqual(error.outcomeKnown, true);
		return true;
	});
});

test('mapa de erros: 404 -> MAGENTO_NOT_FOUND conhecido (produto inexistente e resposta definitiva)', async () => {
	const client = createMagentoReviewsClient({
		http: failWith({ response: { status: 404, data: { message: "The product that was requested doesn't exist." } } }),
		env: ENV,
	});
	await assert.rejects(client.getReviewsBySku('GONE-1'), (error) => {
		assert.strictEqual(error.code, 'MAGENTO_NOT_FOUND');
		assert.strictEqual(error.outcomeKnown, true);
		return true;
	});
});

test('mapa de erros: 429 -> RATE_LIMITED conhecido; 400 -> BAD_REQUEST conhecido', async () => {
	const c429 = createMagentoReviewsClient({ http: failWith({ response: { status: 429 } }), env: ENV });
	await assert.rejects(c429.postReviewsBulk([]), (error) => error.code === 'MAGENTO_RATE_LIMITED' && error.outcomeKnown === true);
	const c400 = createMagentoReviewsClient({ http: failWith({ response: { status: 400, data: { message: 'bad sku' } } }), env: ENV });
	await assert.rejects(c400.postReviewsBulk([]), (error) => error.code === 'MAGENTO_BAD_REQUEST' && error.outcomeKnown === true);
});

test('mapa de erros: ECONNREFUSED conhecido (nada chegou); timeout/5xx DESCONHECIDO', async () => {
	const refused = createMagentoReviewsClient({ http: failWith({ code: 'ECONNREFUSED', message: 'refused' }), env: ENV });
	await assert.rejects(refused.postReviewsBulk([]), (error) => error.code === 'MAGENTO_UNAVAILABLE' && error.outcomeKnown === true);
	const timeout = createMagentoReviewsClient({ http: failWith({ code: 'ECONNABORTED', message: 'timeout of 9000ms exceeded' }), env: ENV });
	await assert.rejects(timeout.postReviewsBulk([]), (error) => error.code === 'MAGENTO_UNAVAILABLE' && error.outcomeKnown === false);
	const http500 = createMagentoReviewsClient({ http: failWith({ response: { status: 500 } }), env: ENV });
	await assert.rejects(http500.postReviewsBulk([]), (error) => error.code === 'MAGENTO_UNAVAILABLE' && error.outcomeKnown === false);
});

test('mensagens de erro nunca carregam o token', async () => {
	const rawError = {
		response: { status: 400, data: { message: 'bad' } },
		config: { headers: { Authorization: 'Bearer secret-token-123' } },
		message: 'Request failed',
	};
	const client = createMagentoReviewsClient({ http: failWith(rawError), env: ENV });
	await assert.rejects(client.postReviewsBulk([]), (error) => {
		assert.ok(!String(error.message).includes('secret-token-123'));
		assert.strictEqual(error.config, undefined);
		return true;
	});
});

test('isConfigured exige MAGENTO_KEY', () => {
	assert.strictEqual(createMagentoReviewsClient({ http: makeHttpStub(async () => ({})), env: {} }).isConfigured(), false);
	assert.strictEqual(createMagentoReviewsClient({ http: makeHttpStub(async () => ({})), env: ENV }).isConfigured(), true);
});

test('MAGENTO_REVIEWS_KEY (token dedicado) tem precedencia sobre o MAGENTO_KEY', async () => {
	const http = makeHttpStub(async () => ({ status: 200, data: [] }));
	const client = createMagentoReviewsClient({ http, env: { ...ENV, MAGENTO_REVIEWS_KEY: 'reviews-only-token' } });
	await client.getReviewsBySku('X');
	assert.strictEqual(http.calls[0].config.headers.Authorization, 'Bearer reviews-only-token');
});
