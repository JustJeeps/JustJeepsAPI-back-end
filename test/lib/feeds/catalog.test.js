const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../../lib/feeds/catalog');

// In-memory Prisma stub covering only what the catalog uses (same spirit as
// the makePrismaStub in test/lib/requestsDigest.test.js).
function makePrismaStub() {
	const feedArtifacts = [];
	const ingestRuns = [];
	let nextId = 1;

	const matches = (row, where) => {
		// The panel reads every feed in one query, so the stub understands
		// { in: [...] } as well as a plain value.
		if (where.feed?.in) {
			if (!where.feed.in.includes(row.feed)) return false;
		} else if (where.feed !== undefined && row.feed !== where.feed) return false;
		if (where.status !== undefined && typeof where.status === 'string' && row.status !== where.status) return false;
		if (where.status?.not !== undefined && row.status === where.status.not) return false;
		if (where.status?.notIn !== undefined && where.status.notIn.includes(row.status)) return false;
		if (where.batchId !== undefined && row.batchId !== where.batchId) return false;
		if (where.fileName?.in && !where.fileName.in.includes(row.fileName)) return false;
		if (where.startedAt?.lt && !(row.startedAt < where.startedAt.lt)) return false;
		return true;
	};

	const feedArtifact = {
		create: async ({ data }) => {
			const row = { id: nextId++, uploadedAt: data.uploadedAt || new Date(), status: 'available', note: null, ...data };
			feedArtifacts.push(row);
			return row;
		},
		updateMany: async ({ where, data }) => {
			let count = 0;
			for (const row of feedArtifacts) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count += 1;
				}
			}
			return { count };
		},
		findMany: async ({ where, orderBy }) => {
			let rows = feedArtifacts.filter((row) => matches(row, where));
			if (orderBy?.uploadedAt === 'desc') rows = rows.sort((a, b) => b.uploadedAt - a.uploadedAt);
			return rows;
		},
	};

	const ingestRun = {
		findFirst: async ({ where }) => {
			const rows = ingestRuns.filter((row) => matches(row, where)).sort((a, b) => b.id - a.id);
			return rows[0] || null;
		},
		findMany: async ({ where, take, skip }) => {
			const rows = ingestRuns.filter((row) => matches(row, where)).sort((a, b) => b.id - a.id);
			return rows.slice(skip || 0, (skip || 0) + (take || rows.length));
		},
		count: async ({ where }) => ingestRuns.filter((row) => matches(row, where)).length,
		updateMany: async ({ where, data }) => {
			let count = 0;
			for (const row of ingestRuns) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count += 1;
				}
			}
			return { count };
		},
	};

	return {
		feedArtifacts,
		ingestRuns,
		feedArtifact,
		ingestRun,
		$transaction: async (fn) => fn({ feedArtifact }),
		_pushRun: (run) => ingestRuns.push({ id: nextId++, ...run }),
	};
}

const file = (fileName, extra = {}) => ({
	fileName,
	objectKey: `feeds/k/${fileName}-${Math.random().toString(16).slice(2)}`,
	sha256: 'a'.repeat(64),
	sizeBytes: 100,
	...extra,
});

test('registerArtifacts supersedes the previous batch and groups by batchId', async () => {
	const prisma = makePrismaStub();

	const first = await catalog.registerArtifacts(prisma, {
		feed: 'keystone-ftp',
		source: 'ftp',
		files: [file('Inventory.csv'), file('SpecialOrder.csv')],
	});
	const second = await catalog.registerArtifacts(prisma, {
		feed: 'keystone-ftp',
		source: 'ftp',
		files: [file('Inventory.csv'), file('SpecialOrder.csv')],
	});

	assert.notStrictEqual(first.batchId, second.batchId);
	const available = prisma.feedArtifacts.filter((row) => row.status === 'available');
	assert.strictEqual(available.length, 2);
	assert.ok(available.every((row) => row.batchId === second.batchId));
	assert.strictEqual(prisma.feedArtifacts.filter((row) => row.status === 'superseded').length, 2);
});

test('a batch built from one new file plus a carried forward one is current', async () => {
	// This is what a partial upload produces: the person had only the CSV, so
	// the spreadsheet comes from the previous batch pointing at the SAME object.
	// The result has to be a complete, current batch, otherwise feed-sync would
	// see no batch and remove the symlinks the vendor scripts read.
	const prisma = makePrismaStub();
	const spreadsheet = file('pricingSheet_quad.xlsx');

	const first = await catalog.registerArtifacts(prisma, {
		feed: 'quadratec',
		source: 'manual',
		files: [file('quadratec_wholesale.csv'), spreadsheet],
	});

	const second = await catalog.registerArtifacts(prisma, {
		feed: 'quadratec',
		source: 'manual',
		files: [
			file('quadratec_wholesale.csv'),
			// carried forward verbatim, same object key
			{ fileName: 'pricingSheet_quad.xlsx', objectKey: spreadsheet.objectKey, sha256: spreadsheet.sha256, sizeBytes: 100 },
		],
	});

	assert.notStrictEqual(first.batchId, second.batchId);

	const current = await catalog.getCurrentBatch(prisma, 'quadratec', ['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx']);
	assert.strictEqual(current.batchId, second.batchId);
	assert.strictEqual(current.artifacts.length, 2);

	// The kept file still points at the object that was already in the bucket:
	// nothing was re-uploaded for it.
	const kept = current.artifacts.find((artifact) => artifact.fileName === 'pricingSheet_quad.xlsx');
	assert.strictEqual(kept.objectKey, spreadsheet.objectKey);
});

test('the date the file carried at the source is recorded, not just the upload time', async () => {
	// Freshness is read from this. Our own copy is always "just now", so a file
	// exported weeks ago and uploaded today has to keep saying weeks ago.
	const prisma = makePrismaStub();
	const exportedAt = new Date('2026-07-16T20:09:00Z');

	await catalog.registerArtifacts(prisma, {
		feed: 'quickbooks',
		source: 'manual',
		files: [file('customers_qb_desktop.csv', { sourceModifiedAt: exportedAt })],
	});

	assert.strictEqual(prisma.feedArtifacts[0].sourceModifiedAt.getTime(), exportedAt.getTime());
});

test('a file with no source date recorded stores null rather than guessing', async () => {
	const prisma = makePrismaStub();

	await catalog.registerArtifacts(prisma, {
		feed: 'ctp',
		source: 'ftp',
		files: [file('CTPENT_Inventory.csv')],
	});

	assert.strictEqual(prisma.feedArtifacts[0].sourceModifiedAt, null);
});

test('the age of a batch is the age of its data, not of the upload', async () => {
	// The Omix spreadsheet was exported in March and uploaded in August. Reading
	// the upload time called a five month old price sheet fresh.
	const prisma = makePrismaStub();
	const exportedInMarch = new Date('2026-03-06T12:32:00Z');

	await catalog.registerArtifacts(prisma, {
		feed: 'omix',
		source: 'manual',
		files: [file('omix-excel.xlsx', { sourceModifiedAt: exportedInMarch })],
	});

	const batch = await catalog.getCurrentBatch(prisma, 'omix', ['omix-excel.xlsx']);
	assert.strictEqual(batch.dataAsOf.getTime(), exportedInMarch.getTime());
	assert.notStrictEqual(batch.uploadedAt.getTime(), exportedInMarch.getTime(), 'the upload time is still available');
});

test('a batch is only as fresh as its oldest file', async () => {
	// What a partial upload produces: a new CSV next to a spreadsheet carried
	// forward from months ago.
	const prisma = makePrismaStub();
	const old = new Date('2026-03-06T12:32:00Z');
	const recent = new Date('2026-08-08T09:00:00Z');

	await catalog.registerArtifacts(prisma, {
		feed: 'quadratec',
		source: 'manual',
		files: [
			file('quadratec_wholesale.csv', { sourceModifiedAt: recent }),
			file('pricingSheet_quad.xlsx', { sourceModifiedAt: old }),
		],
	});

	const batch = await catalog.getCurrentBatch(prisma, 'quadratec', ['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx']);
	assert.strictEqual(batch.dataAsOf.getTime(), old.getTime());
});

test('a file with no recorded source date falls back to when it arrived', async () => {
	const prisma = makePrismaStub();

	await catalog.registerArtifacts(prisma, {
		feed: 'ctp',
		source: 'ftp',
		files: [file('CTPENT_Inventory.csv')],
	});

	const batch = await catalog.getCurrentBatch(prisma, 'ctp', ['CTPENT_Inventory.csv']);
	assert.strictEqual(batch.dataAsOf.getTime(), batch.uploadedAt.getTime());
});

test('the same file cannot be registered twice in one batch', async () => {
	const prisma = makePrismaStub();

	await assert.rejects(
		catalog.registerArtifacts(prisma, {
			feed: 'ctp',
			source: 'manual',
			files: [file('CTPENT_Inventory.csv'), file('CTPENT_Inventory.csv')],
		}),
		/more than once/
	);
	assert.strictEqual(prisma.feedArtifacts.length, 0, 'nothing is written');
});

test('getCurrentBatch ignores an incomplete batch of a multi-file feed', async () => {
	const prisma = makePrismaStub();

	const complete = await catalog.registerArtifacts(prisma, {
		feed: 'keystone-ftp',
		source: 'ftp',
		files: [file('Inventory.csv'), file('SpecialOrder.csv')],
	});
	// Later partial upload: only Inventory, which supersedes the old Inventory,
	// but the new batch does not cover SpecialOrder, so it must NOT become current.
	await catalog.registerArtifacts(prisma, {
		feed: 'keystone-ftp',
		source: 'manual',
		files: [file('Inventory.csv')],
	});

	const current = await catalog.getCurrentBatch(prisma, 'keystone-ftp', ['Inventory.csv', 'SpecialOrder.csv']);
	assert.strictEqual(current, null, 'the partial batch does not cover every file and the complete one lost its Inventory');

	// Completing the partial batch with SpecialOrder in the SAME batch makes it current.
	const partialBatchId = prisma.feedArtifacts
		.filter((row) => row.status === 'available' && row.fileName === 'Inventory.csv')[0].batchId;
	await catalog.registerArtifacts(prisma, {
		feed: 'keystone-ftp',
		batchId: partialBatchId,
		source: 'manual',
		files: [file('SpecialOrder.csv')],
	});
	const nowCurrent = await catalog.getCurrentBatch(prisma, 'keystone-ftp', ['Inventory.csv', 'SpecialOrder.csv']);
	assert.strictEqual(nowCurrent.batchId, partialBatchId);
	assert.notStrictEqual(nowCurrent.batchId, complete.batchId);
});

test('quarantineBatch takes the batch out of circulation and the previous one does not come back on its own', async () => {
	const prisma = makePrismaStub();
	await catalog.registerArtifacts(prisma, { feed: 'ctp', source: 'manual', files: [file('CTPENT_Inventory.csv')] });
	const bad = await catalog.registerArtifacts(prisma, { feed: 'ctp', source: 'manual', files: [file('CTPENT_Inventory.csv')] });

	await catalog.quarantineBatch(prisma, bad.batchId, 'corrupted spreadsheet');

	const current = await catalog.getCurrentBatch(prisma, 'ctp', ['CTPENT_Inventory.csv']);
	assert.strictEqual(current, null, 'the previous one is superseded; quarantine does not reactivate it');
	const quarantined = prisma.feedArtifacts.filter((row) => row.status === 'quarantined');
	assert.strictEqual(quarantined.length, 1);
	assert.strictEqual(quarantined[0].note, 'corrupted spreadsheet');
});

test('quarantineBatch leaves purged rows purged (their object is gone from the bucket)', async () => {
	const prisma = makePrismaStub();
	const batch = await catalog.registerArtifacts(prisma, {
		feed: 'keystone-ftp',
		source: 'ftp',
		files: [file('Inventory.csv'), file('SpecialOrder.csv')],
	});
	prisma.feedArtifacts.find((row) => row.fileName === 'Inventory.csv').status = 'purged';

	await catalog.quarantineBatch(prisma, batch.batchId, 'bad batch');

	const statuses = prisma.feedArtifacts.map((row) => row.status).sort();
	assert.deepStrictEqual(statuses, ['purged', 'quarantined']);
});

test('listRuns filters by feed and status with pagination', async () => {
	const prisma = makePrismaStub();
	prisma._pushRun({ feed: 'keystone-ftp', status: 'success' });
	prisma._pushRun({ feed: 'keystone-ftp', status: 'failed' });
	prisma._pushRun({ feed: 'ctp', status: 'success' });

	const all = await catalog.listRuns(prisma, {});
	assert.strictEqual(all.total, 3);

	const failed = await catalog.listRuns(prisma, { feed: 'keystone-ftp', status: 'failed' });
	assert.strictEqual(failed.total, 1);
	assert.strictEqual(failed.runs[0].status, 'failed');
});

test('listFeedStatuses marks stale by age and treats a missing batch as stale', async () => {
	const prisma = makePrismaStub();
	const now = new Date('2026-08-05T12:00:00Z');
	await catalog.registerArtifacts(prisma, { feed: 'ctp', source: 'manual', files: [file('CTPENT_Inventory.csv')] });
	prisma.feedArtifacts[0].uploadedAt = new Date('2026-08-05T00:00:00Z'); // 12h ago

	const defs = [
		{ name: 'ctp', label: 'CTP', files: ['CTPENT_Inventory.csv'], staleAfterHours: 6, maxUploadBytes: 1, seedCommand: 'seed-ctp' },
		{ name: 'omix', label: 'Omix', files: ['omix-excel.xlsx'], staleAfterHours: 24, maxUploadBytes: 1, seedCommand: 'seed-omix' },
	];
	const statuses = await catalog.listFeedStatuses(prisma, defs, { now });

	assert.strictEqual(statuses[0].stale, true, '12h > 6h threshold');
	assert.strictEqual(Math.round(statuses[0].ageHours), 12);
	assert.strictEqual(statuses[1].currentBatch, null);
	assert.strictEqual(statuses[1].stale, true, 'no batch = stale');
	// The panel uses seedCommand to enable the "Run now" button.
	assert.strictEqual(statuses[0].seedCommand, 'seed-ctp');
	assert.strictEqual(statuses[1].seedCommand, 'seed-omix');
});
