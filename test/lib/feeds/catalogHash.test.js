const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../../lib/feeds/catalog');

// Minimal stub: findFirst with a feed/fileName/sha256/status filter and
// ordering. The status filter implements not/notIn for real — an earlier
// version ignored it and let a test assert the opposite of the actual query.
function matchesStatus(status, filter) {
	if (filter === undefined) return true;
	if (typeof filter === 'string') return status === filter;
	if (filter.not !== undefined) return status !== filter.not;
	if (filter.notIn !== undefined) return !filter.notIn.includes(status);
	throw new Error(`status filter not supported by the stub: ${JSON.stringify(filter)}`);
}

function makePrismaStub(rows = []) {
	return {
		rows,
		feedArtifact: {
			findFirst: async ({ where, orderBy }) => {
				let found = rows.filter((row) =>
					row.feed === where.feed
					&& row.fileName === where.fileName
					&& row.sha256 === where.sha256
					&& matchesStatus(row.status, where.status));
				if (orderBy?.uploadedAt === 'desc') found = found.sort((a, b) => b.uploadedAt - a.uploadedAt);
				return found[0] || null;
			},
		},
	};
}

const artifact = (over = {}) => ({
	id: 1,
	feed: 'ctp',
	fileName: 'CTPENT_Inventory.csv',
	sha256: 'a'.repeat(64),
	objectKey: 'feeds/ctp/2026/08/x-CTPENT_Inventory.csv',
	sizeBytes: 100,
	uploadedAt: new Date('2026-08-01'),
	status: 'superseded',
	...over,
});

test('finds an artifact with the same content (avoids re-uploading the file)', async () => {
	const prisma = makePrismaStub([artifact()]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found.objectKey, 'feeds/ctp/2026/08/x-CTPENT_Inventory.csv');
});

test('different content, different feed or different file do not match', async () => {
	const prisma = makePrismaStub([artifact()]);
	assert.strictEqual(await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'b'.repeat(64)), null);
	assert.strictEqual(await catalog.findArtifactByHash(prisma, 'omix', 'CTPENT_Inventory.csv', 'a'.repeat(64)), null);
	assert.strictEqual(await catalog.findArtifactByHash(prisma, 'ctp', 'other.csv', 'a'.repeat(64)), null);
});

test('with several versions of the same content, returns the most recent one', async () => {
	const prisma = makePrismaStub([
		artifact({ id: 1, objectKey: 'old', uploadedAt: new Date('2026-07-01') }),
		artifact({ id: 2, objectKey: 'recent', uploadedAt: new Date('2026-08-05') }),
	]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found.objectKey, 'recent');
});

test('a quarantined artifact never matches (quarantine is the kill switch for bad content)', async () => {
	const prisma = makePrismaStub([artifact({ status: 'quarantined' })]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found, null);
});

test('a purged artifact never matches (its object was pruned from the bucket — force a re-upload)', async () => {
	const prisma = makePrismaStub([artifact({ status: 'purged' })]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found, null);
});
