const test = require('node:test');
const assert = require('node:assert');

const { createCookieJar } = require('../../../../lib/competitors/niagara/cookieJar');

test('an empty jar sends no cookie header', () => {
	assert.strictEqual(createCookieJar().header(), '');
});

test('the jar keeps name=value pairs and drops the attributes', () => {
	const jar = createCookieJar();
	jar.store(['__cf_bm=abc; path=/; expires=Mon, 02 Nov 2026 12:30:00 GMT; HttpOnly; Secure', 'localization=CA; path=/']);
	assert.strictEqual(jar.header(), '__cf_bm=abc; localization=CA');
});

test('a later cookie with the same name replaces the earlier one', () => {
	const jar = createCookieJar();
	jar.store(['_shopify_y=1; path=/']);
	jar.store(['_shopify_y=2; path=/']);
	assert.strictEqual(jar.header(), '_shopify_y=2');
});

test('storeFrom reads Set-Cookie from a fetch response, with or without getSetCookie', () => {
	const jar = createCookieJar();
	jar.storeFrom({ headers: { getSetCookie: () => ['a=1; path=/'] } });
	jar.storeFrom({ headers: new Headers([['set-cookie', 'b=2; path=/']]) });
	jar.storeFrom({ headers: {} });
	assert.strictEqual(jar.header(), 'a=1; b=2');
});

test('junk lines are ignored', () => {
	const jar = createCookieJar();
	jar.store(['', 'novalue', '=x']);
	assert.strictEqual(jar.header(), '');
});
