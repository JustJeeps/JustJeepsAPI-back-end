const test = require('node:test');
const assert = require('node:assert');

const { closeStaleRuns, BOOT_MAX_AGE_MS } = require('../../../lib/feeds/staleRuns');

function makePrismaStub(rows) {
	return {
		rows,
		ingestRun: {
			updateMany: async ({ where, data }) => {
				let count = 0;
				for (const row of rows) {
					if (row.status !== where.status) continue;
					if (!(row.startedAt < where.startedAt.lt)) continue;
					Object.assign(row, data);
					count += 1;
				}
				return { count };
			},
		},
	};
}

const NOW = new Date('2026-08-06T18:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3600 * 1000);

test('a run left running by a restart is closed as failed', async () => {
	const prisma = makePrismaStub([
		{ feed: 'keystone-ftp-fetch', status: 'running', startedAt: hoursAgo(9) },
	]);

	const closed = await closeStaleRuns(prisma, { now: () => NOW });

	assert.strictEqual(closed, 1);
	assert.strictEqual(prisma.rows[0].status, 'failed');
	assert.match(prisma.rows[0].error, /Interrupted/);
	assert.strictEqual(prisma.rows[0].finishedAt.getTime(), NOW.getTime());
});

test('work still in progress is left alone', async () => {
	// The Keystone fetch moves 460MB and takes around 20 minutes; the cutoff has
	// to stay well clear of the longest legitimate run.
	const prisma = makePrismaStub([
		{ feed: 'keystone-ftp-fetch', status: 'running', startedAt: hoursAgo(0.5) },
		{ feed: 'ctp', status: 'success', startedAt: hoursAgo(48) },
	]);

	assert.strictEqual(await closeStaleRuns(prisma, { now: () => NOW }), 0);
	assert.strictEqual(prisma.rows[0].status, 'running');
	assert.strictEqual(prisma.rows[1].status, 'success');
});

test('the cutoff is configurable', async () => {
	const prisma = makePrismaStub([{ feed: 'ctp', status: 'running', startedAt: hoursAgo(2) }]);

	assert.strictEqual(await closeStaleRuns(prisma, { now: () => NOW, maxAgeMs: 60 * 60 * 1000 }), 1);
});

test('the boot cutoff clears a run the previous container left behind', async () => {
	// Scripts die with the container that spawned them, so on boot anything
	// older than a few minutes is gone. A run that started seconds ago may still
	// be finishing in the outgoing container and is left alone.
	const prisma = makePrismaStub([
		{ feed: 'ctp', status: 'running', startedAt: hoursAgo(0.5) },
		{ feed: 'quadratec', status: 'running', startedAt: hoursAgo(0.01) },
	]);

	assert.strictEqual(await closeStaleRuns(prisma, { now: () => NOW, maxAgeMs: BOOT_MAX_AGE_MS }), 1);
	assert.strictEqual(prisma.rows[0].status, 'failed');
	assert.strictEqual(prisma.rows[1].status, 'running');
});

test('without prisma it does nothing instead of throwing', async () => {
	assert.strictEqual(await closeStaleRuns(null), 0);
});
