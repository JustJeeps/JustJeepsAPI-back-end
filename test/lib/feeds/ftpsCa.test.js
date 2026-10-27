const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isMissingObject, loadConfiguredCa } = require('../../../lib/feeds/ftpsCa');

function recordingLog() {
	const lines = { log: [], warn: [], error: [] };
	return {
		lines,
		log: (msg) => lines.log.push(String(msg)),
		warn: (msg) => lines.warn.push(String(msg)),
		error: (msg) => lines.error.push(String(msg)),
	};
}

function storeFailingWith(error) {
	return { isConfigured: () => true, getObjectStream: async () => { throw error; } };
}

const load = ({ store, log }) => loadConfiguredCa({
	env: {},
	envPrefix: 'JRP_FTP',
	defaultObjectKey: 'certs/jrp-ftp-ca.pem',
	store,
	cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ftpsca-')),
	log,
});

test('a missing bucket object (bare 404 the SDK calls UnknownError) is info, not a warning', async () => {
	const log = recordingLog();
	const error = Object.assign(new Error('UnknownError'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } });

	const pem = await load({ store: storeFailingWith(error), log });

	assert.strictEqual(pem, null);
	assert.deepStrictEqual(log.lines.warn, []);
	assert.ok(log.lines.log.some((line) => line.includes('No pinned CA at certs/jrp-ftp-ca.pem')));
});

test('NoSuchKey and NotFound count as a missing object', () => {
	assert.strictEqual(isMissingObject(Object.assign(new Error('x'), { name: 'NoSuchKey' })), true);
	assert.strictEqual(isMissingObject(Object.assign(new Error('x'), { name: 'NotFound' })), true);
	assert.strictEqual(isMissingObject(Object.assign(new Error('x'), { Code: 'NoSuchKey' })), true);
	assert.strictEqual(isMissingObject(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } })), false);
	assert.strictEqual(isMissingObject(new Error('socket hang up')), false);
	assert.strictEqual(isMissingObject(undefined), false);
});

test('any other bucket failure still warns with the error message', async () => {
	const log = recordingLog();
	const error = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });

	const pem = await load({ store: storeFailingWith(error), log });

	assert.strictEqual(pem, null);
	assert.deepStrictEqual(log.lines.warn, ['⚠️ Could not read certs/jrp-ftp-ca.pem from the bucket: Access Denied']);
});
