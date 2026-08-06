const test = require('node:test');
const assert = require('node:assert');

const { createFeedStore } = require('../../../lib/feeds/feedStore');

const ENV = {
	DO_SPACES_ENDPOINT: 'https://tor1.digitaloceanspaces.com',
	DO_SPACES_REGION: 'tor1',
	DO_SPACES_BUCKET: 'jj-feeds',
	DO_SPACES_KEY: 'key',
	DO_SPACES_SECRET: 'secret',
};

function makeS3Stub() {
	const calls = [];
	return {
		calls,
		send: async (command) => {
			calls.push({ name: command.constructor.name, input: command.input });
			if (command.constructor.name === 'ListPartsCommand') {
				return { Parts: [{ PartNumber: 2, ETag: '"b"', Size: 10 }, { PartNumber: 1, ETag: '"a"', Size: 20 }] };
			}
			return {};
		},
	};
}

test('listParts returns the bucket parts sorted by number', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	const parts = await store.listParts({ key: 'feeds/ctp/x.csv', uploadId: 'u1' });

	assert.deepStrictEqual(parts.map((p) => p.partNumber), [1, 2]);
	assert.strictEqual(parts[0].etag, '"a"');
	assert.strictEqual(s3.calls[0].name, 'ListPartsCommand');
});

test('deleteObject removes the object (used when the upload exceeds the limit)', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	await store.deleteObject('feeds/ctp/x.csv');

	assert.strictEqual(s3.calls[0].name, 'DeleteObjectCommand');
	assert.strictEqual(s3.calls[0].input.Key, 'feeds/ctp/x.csv');
	assert.strictEqual(s3.calls[0].input.Bucket, 'jj-feeds');
});
