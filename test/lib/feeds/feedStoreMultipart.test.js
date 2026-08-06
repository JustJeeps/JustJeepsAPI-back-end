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

test('createMultipartUpload abre o upload no bucket certo, privado', async () => {
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

test('completeMultipartUpload envia as partes na ordem com ETag e numero', async () => {
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

test('headObject devolve o tamanho REAL do objeto (nao o que o cliente afirma)', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	const head = await store.headObject('feeds/ctp/x.csv');

	assert.strictEqual(head.sizeBytes, 1234);
	assert.strictEqual(s3.calls[0].name, 'HeadObjectCommand');
});

test('abortMultipartUpload cancela o upload pendente', async () => {
	const s3 = makeS3Stub();
	const store = createFeedStore({ s3, env: ENV });

	await store.abortMultipartUpload({ key: 'feeds/ctp/x.csv', uploadId: 'upload-1' });

	assert.strictEqual(s3.calls[0].name, 'AbortMultipartUploadCommand');
	assert.strictEqual(s3.calls[0].input.UploadId, 'upload-1');
});

// Assinatura e calculo LOCAL (sem rede), entao aqui usamos o client real.
test('signUploadPart gera URL assinada com validade e amarrada a key/parte', async () => {
	const store = createFeedStore({ env: ENV });

	const url = await store.signUploadPart({ key: 'feeds/ctp/x.csv', uploadId: 'upload-1', partNumber: 3 });

	assert.match(url, /^https:\/\//);
	assert.ok(url.includes('partNumber=3'), 'a URL vale para a parte 3');
	assert.ok(url.includes('uploadId=upload-1'), 'e para este upload');
	assert.ok(/X-Amz-Expires=\d+/.test(url), 'tem expiracao');
	assert.ok(!url.includes('secret'), 'a secret nunca aparece na URL');
});
