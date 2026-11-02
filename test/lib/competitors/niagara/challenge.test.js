const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { classifyResponse, parseRetryAfterMs } = require('../../../../lib/competitors/niagara/challenge');

const challengeHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'cf-challenge.html'), 'utf8');
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };

test('a JSON answer to a JSON request is json', () => {
	const result = classifyResponse({ status: 200, headers: jsonHeaders, bodyText: '{"products":[]}', expectJson: true });
	assert.strictEqual(result.kind, 'json');
});

test('the Cloudflare managed challenge page is a challenge even with HTTP 200', () => {
	const result = classifyResponse({ status: 200, headers: htmlHeaders, bodyText: challengeHtml, expectJson: true });
	assert.strictEqual(result.kind, 'challenge');
});

test('the cf-mitigated header alone marks a challenge', () => {
	const result = classifyResponse({ status: 403, headers: { ...htmlHeaders, 'cf-mitigated': 'challenge' }, bodyText: '<html></html>', expectJson: true });
	assert.strictEqual(result.kind, 'challenge');
});

test('an HTML page where JSON was asked for is treated as a challenge, never parsed', () => {
	const result = classifyResponse({ status: 200, headers: htmlHeaders, bodyText: '<html><body>shop</body></html>', expectJson: true });
	assert.strictEqual(result.kind, 'challenge');
	assert.match(result.reason, /html/i);
});

test('an HTML page where HTML was asked for is html', () => {
	const result = classifyResponse({ status: 200, headers: htmlHeaders, bodyText: '<html><body>brands</body></html>', expectJson: false });
	assert.strictEqual(result.kind, 'html');
});

test('HTTP 429 is rate-limited and carries Retry-After in milliseconds', () => {
	const result = classifyResponse({ status: 429, headers: { 'retry-after': '60' }, bodyText: '', expectJson: true });
	assert.strictEqual(result.kind, 'rate-limited');
	assert.strictEqual(result.retryAfterMs, 60000);
});

test('other HTTP errors are errors with the status', () => {
	const result = classifyResponse({ status: 404, headers: jsonHeaders, bodyText: '{"errors":"Not Found"}', expectJson: true });
	assert.strictEqual(result.kind, 'error');
	assert.strictEqual(result.status, 404);
});

test('headers can be a fetch Headers object', () => {
	const headers = new Headers({ 'content-type': 'application/json' });
	assert.strictEqual(classifyResponse({ status: 200, headers, bodyText: '[]', expectJson: true }).kind, 'json');
});

test('parseRetryAfterMs reads seconds and HTTP dates, and ignores junk', () => {
	assert.strictEqual(parseRetryAfterMs('5'), 5000);
	const now = Date.parse('2026-11-02T12:00:00Z');
	assert.strictEqual(parseRetryAfterMs('Mon, 02 Nov 2026 12:00:30 GMT', now), 30000);
	assert.strictEqual(parseRetryAfterMs('Mon, 02 Nov 2026 11:00:00 GMT', now), 0);
	assert.strictEqual(parseRetryAfterMs('soon'), null);
	assert.strictEqual(parseRetryAfterMs(undefined), null);
});
