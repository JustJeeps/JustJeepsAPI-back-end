const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFeedStore } = require('../../../lib/feeds/feedStore');

const ENV_OK = {
	DO_SPACES_ENDPOINT: 'https://tor1.digitaloceanspaces.com',
	DO_SPACES_REGION: 'tor1',
	DO_SPACES_BUCKET: 'jj-attachments',
	DO_SPACES_KEY: 'key',
	DO_SPACES_SECRET: 'secret',
};

function makeS3Stub() {
	const calls = [];
	return {
		calls,
		send: async (command) => {
			calls.push({ name: command.constructor.name, input: command.input });
			if (command.constructor.name === 'ListObjectsV2Command') {
				return { Contents: [{ Key: 'feeds/x/a.csv', Size: 10, LastModified: new Date('2026-08-01') }] };
			}
			return {};
		},
	};
}

test('isConfigured exige endpoint, bucket, key e secret', () => {
	assert.strictEqual(createFeedStore({ env: {} }).isConfigured(), false);
	assert.strictEqual(createFeedStore({ env: { ...ENV_OK, DO_SPACES_SECRET: '' } }).isConfigured(), false);
	assert.strictEqual(createFeedStore({ env: ENV_OK }).isConfigured(), true);
});

test('bucket dedicado DO_SPACES_FEEDS_BUCKET tem precedencia sobre o de anexos', () => {
	assert.strictEqual(createFeedStore({ env: ENV_OK }).bucket(), 'jj-attachments');
	assert.strictEqual(
		createFeedStore({ env: { ...ENV_OK, DO_SPACES_FEEDS_BUCKET: 'jj-feeds' } }).bucket(),
		'jj-feeds'
	);
});

test('buildKey segue feeds/{feed}/{YYYY}/{MM}/{ts}-{sha8}-{fileName}', () => {
	const store = createFeedStore({ env: ENV_OK });
	const key = store.buildKey({
		feed: 'keystone-ftp',
		fileName: 'Inventory.csv',
		sha256: 'abcdef0123456789'.repeat(4),
		at: new Date('2026-08-05T12:34:56.789Z'),
	});
	assert.strictEqual(key, 'feeds/keystone-ftp/2026/08/20260805T123456Z-abcdef01-Inventory.csv');
});

test('putFile envia PutObjectCommand com ContentLength, ACL private e stream do arquivo', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV_OK });
	const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feedstore-')), 'a.csv');
	fs.writeFileSync(tmpFile, 'sku,cost\n');

	await store.putFile({ key: 'feeds/ctp/a.csv', filePath: tmpFile, contentType: 'text/csv', sizeBytes: 9 });

	assert.strictEqual(s3.calls.length, 1);
	const { name, input } = s3.calls[0];
	assert.strictEqual(name, 'PutObjectCommand');
	assert.strictEqual(input.Bucket, 'jj-attachments');
	assert.strictEqual(input.Key, 'feeds/ctp/a.csv');
	assert.strictEqual(input.ContentLength, 9);
	assert.strictEqual(input.ContentType, 'text/csv');
	assert.strictEqual(input.ACL, 'private');
	assert.ok(typeof input.Body.pipe === 'function');
});

test('getObjectStream e listObjects delegam para o client', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV_OK });

	await store.getObjectStream('feeds/x/a.csv');
	const objects = await store.listObjects('feeds/x/');

	assert.deepStrictEqual(s3.calls.map((call) => call.name), ['GetObjectCommand', 'ListObjectsV2Command']);
	assert.deepStrictEqual(objects, [{ key: 'feeds/x/a.csv', size: 10, lastModified: new Date('2026-08-01') }]);
});
