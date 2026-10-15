const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Route-level test. Two bugs shipped today from this file that no unit test
// could see: a default parameter referencing a module that was never imported,
// and a block of carry-forward logic that landed in the wrong handler and read
// a variable that does not exist there ("currentBatch is not defined", a 500 on
// every partial upload). Both are runtime errors inside a request, so the only
// thing that catches them is actually driving a request through the router.
//
// Prisma, the bucket and the runner are stubbed through require.cache, so this
// touches no database, no network and no disk.

const stub = (relativePath, exports) => {
	require.cache[require.resolve(relativePath)] = { id: relativePath, filename: relativePath, loaded: true, exports };
};

const artifacts = [];
let nextId = 1;

const prismaStub = {
	feedArtifact: {
		findMany: async ({ where }) => artifacts.filter((row) =>
			row.feed === where.feed
			&& row.status === where.status
			&& (!where.fileName?.in || where.fileName.in.includes(row.fileName))),
		updateMany: async ({ where, data }) => {
			let count = 0;
			for (const row of artifacts) {
				if (row.feed === where.feed && where.fileName?.in?.includes(row.fileName) && row.status === where.status) {
					Object.assign(row, data);
					count += 1;
				}
			}
			return { count };
		},
		create: async ({ data }) => {
			const row = { id: nextId++, status: 'available', uploadedAt: new Date(), note: null, sourceModifiedAt: null, ...data };
			artifacts.push(row);
			return row;
		},
		findFirst: async () => null,
	},
	ingestRun: { findMany: async () => [], count: async () => 0, updateMany: async () => ({ count: 0 }) },
	$transaction: async (fn) => fn(prismaStub),
};

stub('../../lib/prisma', prismaStub);
stub('../../lib/feeds/feedStore', {
	createFeedStore: () => ({
		isConfigured: () => true,
		buildKey: ({ feed, fileName, sha256 }) => `feeds/${feed}/${sha256.slice(0, 8)}-${fileName}`,
		// One id per call: a commit of two files holds two sessions at once.
		createMultipartUpload: async () => ({ uploadId: `multipart-${nextId++}` }),
		signPart: async () => 'https://bucket.example/signed-part',
		listParts: async () => [{ PartNumber: 1 }],
		completeMultipartUpload: async () => ({}),
		headObject: async () => ({ sizeBytes: 1024 }),
		deleteObject: async () => ({}),
		abortMultipartUpload: async () => ({}),
	}),
});
stub('../../services/feeds/runnerInstance', {
	getRun: () => null,
	getStatus: async () => null,
	busyFeed: () => null,
	isDailySyncRunning: () => false,
	start: () => ({}),
});

const express = require('express');
const ingestRouter = require('../../routes/ingest');

// Uploading is triage only, so the fake request has to carry a user from the
// allowlist the module actually resolved (env or its default).
const TRIAGE_USER = require('../../config/triage').config.triageUsers[0];

function startServer() {
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => { req.user = { username: TRIAGE_USER, id: 1 }; next(); });
	app.use('/api/ingest', ingestRouter);
	return new Promise((resolve) => {
		const server = app.listen(0, () => resolve({ server, port: server.address().port }));
	});
}

const post = (port, url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

// Puts a batch in the catalog, the way an upload would. Only the file names
// given, so a test can start from the batches that exist in production before
// the feed gained its third file.
const seedBatch = async (fileNames) => {
	artifacts.length = 0;
	const { registerArtifacts } = require('../../lib/feeds/catalog');
	await registerArtifacts(prismaStub, {
		feed: 'quadratec',
		source: 'manual',
		files: fileNames.map((fileName, index) => ({
			fileName,
			objectKey: `feeds/quadratec/old-${fileName}`,
			sha256: String.fromCharCode(97 + index).repeat(64),
			sizeBytes: 10 * (index + 1),
		})),
	});
};

const QUADRATEC_FILES = ['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx', 'pricingKit_quad.xlsx'];

// Drives the browser flow for one file: upload slot, bytes, multipart done.
const uploadFile = async (port, fileName, sha256) => {
	const init = await post(port, '/api/ingest/feeds/quadratec/uploads', { fileName, sizeBytes: 1024 })
		.then((res) => res.json());
	assert.ok(init.uploadId, `expected an upload id for ${fileName}, got ${JSON.stringify(init)}`);
	const done = await post(port, `/api/ingest/feeds/quadratec/uploads/${init.uploadId}/complete`, { sha256 });
	assert.strictEqual(done.status, 200, await done.text());
	return init.uploadId;
};

test('a partial upload completes the batch from the current one', async () => {
	await seedBatch(QUADRATEC_FILES);
	const { server, port } = await startServer();

	try {
		// The browser asks for an upload slot, sends the bytes, finishes the
		// multipart, then commits the set. Only the CSV is sent here.
		const init = await post(port, '/api/ingest/feeds/quadratec/uploads', {
			fileName: 'quadratec_wholesale.csv',
			sizeBytes: 1024,
		}).then((res) => res.json());
		assert.ok(init.uploadId, `expected an upload id, got ${JSON.stringify(init)}`);

		const done = await post(port, `/api/ingest/feeds/quadratec/uploads/${init.uploadId}/complete`, {
			sha256: 'c'.repeat(64),
		});
		assert.strictEqual(done.status, 200, await done.text());

		const response = await post(port, '/api/ingest/feeds/quadratec/uploads/commit', {
			uploadIds: [init.uploadId],
			reuse: [],
		});
		const body = await response.json();

		assert.strictEqual(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(body)}`);
		assert.strictEqual(body.isCurrent, true, 'the new batch has to be readable right away');
		assert.deepStrictEqual(
			body.carriedForward.map((file) => file.fileName),
			['pricingSheet_quad.xlsx', 'pricingKit_quad.xlsx'],
			'the files that were not sent are named back, so the panel can say what it kept'
		);

		// The kept file points at the object that was already stored: nothing was
		// re-uploaded for it.
		const kept = body.artifacts.find((artifact) => artifact.fileName === 'pricingSheet_quad.xlsx');
		assert.strictEqual(kept.objectKey, 'feeds/quadratec/old-pricingSheet_quad.xlsx');
	} finally {
		server.close();
	}
});

// The transition when a feed gains a file: production holds batches with the
// CSV and the sheet only, so no batch covers every file. The first upload of
// the new kit, sent together with the sheet, still has to carry the CSV from
// the old batch and come out as a complete three-file batch.
test('a missing file is carried from the latest stored copy even when no batch covers every file', async () => {
	await seedBatch(['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx']);
	const { server, port } = await startServer();

	try {
		const sheetId = await uploadFile(port, 'pricingSheet_quad.xlsx', 'c'.repeat(64));
		const kitId = await uploadFile(port, 'pricingKit_quad.xlsx', 'd'.repeat(64));

		const response = await post(port, '/api/ingest/feeds/quadratec/uploads/commit', {
			uploadIds: [sheetId, kitId],
			reuse: [],
		});
		const body = await response.json();

		assert.strictEqual(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(body)}`);
		assert.strictEqual(body.isCurrent, true, 'the three-file batch is the current one');
		assert.deepStrictEqual(body.carriedForward.map((file) => file.fileName), ['quadratec_wholesale.csv']);
		assert.deepStrictEqual(
			body.artifacts.map((artifact) => artifact.fileName).sort(),
			[...QUADRATEC_FILES].sort()
		);
		const kept = body.artifacts.find((artifact) => artifact.fileName === 'quadratec_wholesale.csv');
		assert.strictEqual(kept.objectKey, 'feeds/quadratec/old-quadratec_wholesale.csv');
	} finally {
		server.close();
	}
});

test('a file that was never stored cannot be carried forward and is named in the 409', async () => {
	await seedBatch(['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx']);
	const { server, port } = await startServer();

	try {
		// Only the sheet: the CSV can be carried, the kit has never been uploaded.
		const sheetId = await uploadFile(port, 'pricingSheet_quad.xlsx', 'c'.repeat(64));

		const response = await post(port, '/api/ingest/feeds/quadratec/uploads/commit', { uploadIds: [sheetId] });
		const body = await response.json();

		assert.strictEqual(response.status, 409, JSON.stringify(body));
		assert.strictEqual(body.code, 'FEED_BATCH_INCOMPLETE');
		assert.deepStrictEqual(body.missing, ['pricingKit_quad.xlsx']);
		assert.match(body.error, /pricingKit_quad\.xlsx/);
		assert.doesNotMatch(body.error, /quadratec_wholesale\.csv/, 'the CSV could be carried, so it is not asked for');

		// Nothing was catalogued: the old batch is untouched.
		assert.ok(artifacts.every((row) => row.status === 'available' && row.objectKey.startsWith('feeds/quadratec/old-')));
	} finally {
		server.close();
	}
});

test('the first upload of a feed still needs every file', async () => {
	artifacts.length = 0; // no previous batch to carry anything forward from
	const { server, port } = await startServer();

	try {
		const init = await post(port, '/api/ingest/feeds/quadratec/uploads', {
			fileName: 'quadratec_wholesale.csv',
			sizeBytes: 1024,
		}).then((res) => res.json());

		await post(port, `/api/ingest/feeds/quadratec/uploads/${init.uploadId}/complete`, { sha256: 'c'.repeat(64) });

		const response = await post(port, '/api/ingest/feeds/quadratec/uploads/commit', { uploadIds: [init.uploadId] });
		const body = await response.json();

		assert.strictEqual(response.status, 409);
		assert.strictEqual(body.code, 'FEED_BATCH_INCOMPLETE');
	} finally {
		server.close();
	}
});
