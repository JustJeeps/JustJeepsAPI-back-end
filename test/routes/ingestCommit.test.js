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
		createMultipartUpload: async () => ({ uploadId: 'multipart-1' }),
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

// Puts a complete batch in the catalog, the way a first upload would.
const seedCurrentBatch = async () => {
	artifacts.length = 0;
	const { registerArtifacts } = require('../../lib/feeds/catalog');
	await registerArtifacts(prismaStub, {
		feed: 'quadratec',
		source: 'manual',
		files: [
			{ fileName: 'quadratec_wholesale.csv', objectKey: 'feeds/quadratec/old-csv', sha256: 'a'.repeat(64), sizeBytes: 10 },
			{ fileName: 'pricingSheet_quad.xlsx', objectKey: 'feeds/quadratec/old-xlsx', sha256: 'b'.repeat(64), sizeBytes: 20 },
		],
	});
};

test('a partial upload completes the batch from the current one', async () => {
	await seedCurrentBatch();
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
			['pricingSheet_quad.xlsx'],
			'the file that was not sent is named back, so the panel can say what it kept'
		);

		// The kept file points at the object that was already stored: nothing was
		// re-uploaded for it.
		const kept = body.artifacts.find((artifact) => artifact.fileName === 'pricingSheet_quad.xlsx');
		assert.strictEqual(kept.objectKey, 'feeds/quadratec/old-xlsx');
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
