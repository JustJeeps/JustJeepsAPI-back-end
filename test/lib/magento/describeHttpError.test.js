const test = require('node:test');
const assert = require('node:assert');

const { describeHttpError } = require('../../../lib/magento/describeHttpError.js');

const TOKEN = 'y6hyef5lqs7c94f43sui1vhb38693zy4';

// Shape of the AxiosError the seeds used to dump whole into the log: the
// request headers (with the bearer token) and the HTML body of the 502 page.
function makeAxiosError() {
	const error = new Error('Request failed with status code 502');
	error.isAxiosError = true;
	error.code = 'ERR_BAD_RESPONSE';
	error.config = {
		method: 'get',
		url: 'https://www.justjeeps.com/rest/V1/orders?searchCriteria[pageSize]=100',
		headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
	};
	error.request = { _header: `GET /rest/V1/orders HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\n` };
	error.response = {
		status: 502,
		statusText: 'Bad Gateway',
		headers: { 'x-sucuri-id': '14017', 'content-type': 'text/html' },
		data: '<!doctype html><html><body><h1>Hosting Server Connect Timeout</h1></body></html>',
	};
	return error;
}

test('an axios error is reduced to status, code, message and url, without the token or the HTML body', () => {
	const summary = describeHttpError(makeAxiosError());

	assert.deepStrictEqual(summary, {
		status: 502,
		code: 'ERR_BAD_RESPONSE',
		message: 'Request failed with status code 502',
		url: 'https://www.justjeeps.com/rest/V1/orders?searchCriteria[pageSize]=100',
	});
	const serialized = JSON.stringify(summary);
	assert.ok(!serialized.includes(TOKEN), 'token must not leak');
	assert.ok(!/bearer/i.test(serialized), 'Authorization header must not leak');
	assert.ok(!serialized.includes('<html'), 'HTML body must not leak');
});

test('a network error without a response keeps its code and message', () => {
	const error = new Error('connect ETIMEDOUT');
	error.isAxiosError = true;
	error.code = 'ETIMEDOUT';
	error.config = { url: 'https://www.justjeeps.com/rest/V1/orders' };

	assert.deepStrictEqual(describeHttpError(error), {
		status: null,
		code: 'ETIMEDOUT',
		message: 'connect ETIMEDOUT',
		url: 'https://www.justjeeps.com/rest/V1/orders',
	});
});

test('an error that did not come from axios is returned untouched so the stack stays in the log', () => {
	const error = new TypeError('Cannot read properties of undefined');
	assert.strictEqual(describeHttpError(error), error);
	assert.strictEqual(describeHttpError(null), null);
	assert.strictEqual(describeHttpError('boom'), 'boom');
});
