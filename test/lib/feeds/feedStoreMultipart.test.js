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
		config: { region: async () => 'tor1', credentials: async () => ({ accessKeyId: 'k', secretAccessKey: 's' }) },
		send: async (command) => {
			const name = command.constructor.name;
			calls.push({ name, input: command.input });
			if (name === 'CreateMultipartUploadCommand') return { UploadId: 'upload-1' };
			if (name === 'HeadObjectCommand') return { ContentLength: 1234, ContentType: 'text/csv', ETag: '"abc"' };
			return {};
		},
	};
}

test('createMultipartUpload opens the upload in the right bucket, private', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	const result = await store.createMultipartUpload({ key: 'feeds/ctp/x.csv', contentType: 'text/csv' });

	assert.strictEqual(result.uploadId, 'upload-1');
	const call = s3.calls[0];
	assert.strictEqual(call.name, 'CreateMultipartUploadCommand');
	assert.strictEqual(call.input.Bucket, 'jj-feeds');
	assert.strictEqual(call.input.Key, 'feeds/ctp/x.csv');
	assert.strictEqual(call.input.ACL, 'private');
});

test('completeMultipartUpload sends the parts in order with ETag and number', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	await store.completeMultipartUpload({
		key: 'feeds/ctp/x.csv',
		uploadId: 'upload-1',
		parts: [{ partNumber: 1, etag: '"a"' }, { partNumber: 2, etag: '"b"' }],
	});

	const call = s3.calls[0];
	assert.strictEqual(call.name, 'CompleteMultipartUploadCommand');
	assert.deepStrictEqual(call.input.MultipartUpload.Parts, [
		{ ETag: '"a"', PartNumber: 1 },
		{ ETag: '"b"', PartNumber: 2 },
	]);
});

test('headObject returns the REAL object size (not what the client claims)', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	const head = await store.headObject('feeds/ctp/x.csv');

	assert.strictEqual(head.sizeBytes, 1234);
	assert.strictEqual(s3.calls[0].name, 'HeadObjectCommand');
});

test('abortMultipartUpload cancels the pending upload', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	await store.abortMultipartUpload({ key: 'feeds/ctp/x.csv', uploadId: 'upload-1' });

	assert.strictEqual(s3.calls[0].name, 'AbortMultipartUploadCommand');
	assert.strictEqual(s3.calls[0].input.UploadId, 'upload-1');
});

// Signing is computed LOCALLY (no network), so here we use the real client.
test('signUploadPart generates a signed URL with an expiry, bound to the key and part', async () => {
	const store = createFeedStore({ env: ENV });

	const url = await store.signUploadPart({ key: 'feeds/ctp/x.csv', uploadId: 'upload-1', partNumber: 3 });

	assert.match(url, /^https:\/\//);
	assert.ok(url.includes('partNumber=3'), 'the URL is valid for part 3');
	assert.ok(url.includes('uploadId=upload-1'), 'and for this upload');
	assert.ok(/X-Amz-Expires=\d+/.test(url), 'it has an expiry');
	assert.ok(!url.includes('secret'), 'the secret never shows up in the URL');
});
