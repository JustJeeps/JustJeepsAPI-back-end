const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseApiKey, parseSearchDomain, discoverConfig } = require('../../../../lib/competitors/tdot/discoverConfig');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/storefront-snippet.html'), 'utf8');
const klevuConfig = require('./fixtures/klevu-config.json');
const silent = { info() {}, warn() {}, error() {} };
const args = { storefrontUrl: 'https://www.tdotperformance.ca/', klevuConfigBaseUrl: 'https://js.klevu.com/klevu-js-v1/klevu-js-api', userAgent: 'ua', timeoutMs: 1000, logger: silent, fallbackApiKey: '', fallbackSearchDomain: '' };

test('parseApiKey finds the public key in the storefront HTML', () => {
	assert.strictEqual(parseApiKey(html), 'klevu-16884958633259895');
	assert.strictEqual(parseApiKey('<html></html>'), null);
	assert.strictEqual(parseApiKey(null), null);
});

test('parseSearchDomain reads the cloud host from the Klevu config JSON', () => {
	assert.strictEqual(parseSearchDomain(klevuConfig), 'uscs32.ksearchnet.com');
	assert.strictEqual(parseSearchDomain({}), null);
});

test('discoverConfig reads the page then the config, and reports the source', async () => {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		if (url === args.storefrontUrl) return { ok: true, status: 200, text: async () => html };
		if (url === `${args.klevuConfigBaseUrl}/klevu-16884958633259895.json`) return { ok: true, status: 200, json: async () => klevuConfig };
		return { ok: false, status: 404 };
	};
	const found = await discoverConfig({ ...args, fetch });
	assert.deepStrictEqual(found, { apiKey: 'klevu-16884958633259895', searchDomain: 'uscs32.ksearchnet.com', source: 'page' });
	assert.strictEqual(calls.length, 2);
});

test('discoverConfig falls back to the env values and fails loud when it has nothing', async () => {
	const fetch = async () => ({ ok: false, status: 503 });
	const fromEnv = await discoverConfig({ ...args, fetch, fallbackApiKey: 'klevu-env', fallbackSearchDomain: 'env.ksearchnet.com' });
	assert.deepStrictEqual(fromEnv, { apiKey: 'klevu-env', searchDomain: 'env.ksearchnet.com', source: 'env' });
	await assert.rejects(discoverConfig({ ...args, fetch }), (e) => e.code === 'TDOT_CONFIG_NOT_FOUND');
});
