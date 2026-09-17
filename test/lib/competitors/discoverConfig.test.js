const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseWidgetConfig, discoverConfig } = require('../../../lib/competitors/lowriders/discoverConfig');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/brand-page.html'), 'utf8');
const FAKE_KEY = '11111111-2222-3333-4444-555555555555';
const silent = { info() {}, warn() {}, error() {} };

function fetchStub(status, body) {
	return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

test('parses the API key and groupId out of the brand page', () => {
	assert.deepStrictEqual(parseWidgetConfig(html), { apiKey: FAKE_KEY, groupId: 61039 });
});

test('page without the widget config yields nulls, not a throw', () => {
	assert.deepStrictEqual(parseWidgetConfig('<html></html>'), { apiKey: null, groupId: null });
});

test('discoverConfig prefers the key on the page', async () => {
	const result = await discoverConfig({
		fetch: fetchStub(200, html), brandPageUrl: 'https://x/b', fallbackApiKey: 'env-key', userAgent: 'ua', timeoutMs: 1000, logger: silent,
	});
	assert.deepStrictEqual(result, { apiKey: FAKE_KEY, groupId: 61039, source: 'page' });
});

// The key can rotate or the widget can change shape; the env fallback keeps
// the run alive and the log says where the key came from.
test('discoverConfig falls back to the env key when the page has none', async () => {
	const result = await discoverConfig({
		fetch: fetchStub(200, '<html></html>'), brandPageUrl: 'https://x/b', fallbackApiKey: 'env-key', userAgent: 'ua', timeoutMs: 1000, logger: silent,
	});
	assert.deepStrictEqual(result, { apiKey: 'env-key', groupId: null, source: 'env' });
});

test('discoverConfig fails loudly with a code when neither source has a key, without leaking keys', async () => {
	await assert.rejects(
		discoverConfig({
			fetch: async () => { throw new Error('boom'); }, brandPageUrl: 'https://x/b', fallbackApiKey: '', userAgent: 'ua', timeoutMs: 1000, logger: silent,
		}),
		(err) => err.code === 'LOWRIDERS_CONFIG_NOT_FOUND' && !err.message.includes(FAKE_KEY),
	);
});
