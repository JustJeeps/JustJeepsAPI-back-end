const test = require('node:test');
const assert = require('node:assert');

const { defineStoreProfile } = require('../../../../lib/competitors/shopify/profile');
const { createShopifyClient } = require('../../../../lib/competitors/shopify/shopifyClient');
const { createRequester } = require('../../../../lib/competitors/shopify/requester');
const { NIAGARA_PROFILE } = require('../../../../lib/competitors/niagara/profile');

const spec = {
	key: 'shopx', errorPrefix: 'SHOPX', shortName: 'Shop X', competitor: { name: 'Shop X', website: 'https://shopx.test/' },
	mapping: { handleField: 'shopx_code', prefixesField: 'shopx_sku_prefixes' },
};
const response = (status, body, contentType = 'application/json') => ({ status, headers: new Headers({ 'content-type': contentType }), text: async () => body });

test('a profile gives the error codes, the log tag and safe defaults', () => {
	const profile = defineStoreProfile(spec);
	assert.strictEqual(profile.code('PAGE_CAP'), 'SHOPX_PAGE_CAP');
	assert.strictEqual(profile.tag, '[shopx]');
	assert.strictEqual(profile.command, 'seed-shopx');
	assert.strictEqual(profile.maxIndexPages, 20);
	assert.strictEqual(profile.purity, 'vendor');
	assert.strictEqual(profile.brandPagePath, null);
	assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.competitor));
});

test('a profile refuses a missing field or an unknown purity rule', () => {
	assert.throws(() => defineStoreProfile({ ...spec, key: '' }), /needs a key/);
	assert.throws(() => defineStoreProfile({ ...spec, mapping: { handleField: 'x' } }), /prefixesField/);
	assert.throws(() => defineStoreProfile({ ...spec, purity: 'guess' }), /unknown purity rule/);
});

test('the Niagara profile keeps the codes, fields and purity Niagara always had', () => {
	assert.strictEqual(NIAGARA_PROFILE.code('CHALLENGED'), 'NIAGARA_CHALLENGED');
	assert.strictEqual(NIAGARA_PROFILE.tag, '[niagara]');
	assert.deepStrictEqual(NIAGARA_PROFILE.mapping, { handleField: 'niagara_code', prefixesField: 'niagara_sku_prefixes' });
	assert.strictEqual(NIAGARA_PROFILE.purity, 'vendor');
	assert.strictEqual(NIAGARA_PROFILE.brandPagePath, '/pages/shop-by-brand');
});

test('the shared client names its errors with the store prefix', async () => {
	const profile = defineStoreProfile(spec);
	const client = createShopifyClient({ fetch: async () => response(404, 'nope', 'text/html'), baseUrl: 'https://shopx.test', userAgent: 'ua', profile });
	await assert.rejects(client.fetchCollectionPage({ handle: 'x', page: 1, limit: 250 }), (e) => e.code === 'SHOPX_NOT_FOUND');
	assert.throws(() => client.fetchBrandPage(), (e) => e.code === 'SHOPX_NO_BRAND_PAGE');
});

test('the shared requester retries the store rate-limit code and logs with the store tag', async () => {
	const profile = defineStoreProfile(spec);
	const warnings = [];
	const requester = createRequester({ sleep: async () => {}, delayMs: 0, jitterMs: 0, logger: { warn: (m) => warnings.push(m) }, profile });
	let calls = 0;
	const value = await requester.run('page 1', async () => {
		calls += 1;
		if (calls === 1) throw Object.assign(new Error('429'), { code: 'SHOPX_RATE_LIMITED', retryable: true, retryAfterMs: 5 });
		return 'ok';
	});
	assert.strictEqual(value, 'ok');
	assert.strictEqual(requester.stats().rateLimited, 1);
	assert.match(warnings[0], /^\[shopx\] page 1: SHOPX_RATE_LIMITED/);
});
