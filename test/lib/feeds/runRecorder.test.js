const test = require('node:test');
const assert = require('node:assert');

const { recordScriptRun, findFeedByCommand } = require('../../../lib/feeds/runRecorder');

function makePrismaStub(existing = []) {
	const created = [];
	return {
		created,
		ingestRun: {
			findFirst: async ({ where }) =>
				existing.find((row) => row.feed === where.feed && row.startedAt >= where.startedAt.gte) || null,
			create: async ({ data }) => {
				created.push(data);
				return { id: created.length, ...data };
			},
		},
	};
}

const CTP = { name: 'ctp' };
const QUADRATEC = { name: 'quadratec', ingestFeed: 'quadratec' };

test('every vendor script maps to the feed it belongs to', () => {
	assert.strictEqual(findFeedByCommand('seed-ctp').name, 'ctp');
	assert.strictEqual(findFeedByCommand('seed-keyparts').name, 'keyparts');
	assert.strictEqual(findFeedByCommand('seed-wp-inventory').name, 'wheelpros-inventory');
	// A feed with several scripts answers for each one of them.
	assert.strictEqual(findFeedByCommand('seed-quadratec').name, 'quadratec');
	assert.strictEqual(findFeedByCommand('seed-quad-inventory').name, 'quadratec');
	assert.strictEqual(findFeedByCommand('seed-meyer'), null, 'a script with no feed maps to nothing');
});

test('a script that records nothing gets its outcome recorded', async () => {
	const prisma = makePrismaStub();
	const startedAt = new Date('2026-08-06T12:00:00Z');

	await recordScriptRun(prisma, {
		feed: CTP,
		command: 'seed-ctp',
		startedAt,
		finishedAt: new Date('2026-08-06T12:00:25Z'),
		status: 'success',
	});

	assert.strictEqual(prisma.created.length, 1);
	assert.strictEqual(prisma.created[0].feed, 'ctp');
	assert.strictEqual(prisma.created[0].status, 'success');
	assert.strictEqual(prisma.created[0].sourceKind, 'script-run');
	assert.strictEqual(prisma.created[0].sourceRef, 'seed-ctp');
});

test('a script that records its own run is left alone', async () => {
	const startedAt = new Date('2026-08-06T12:00:00Z');
	// The seed wrote its detailed row (with row counts) during the run.
	const prisma = makePrismaStub([{ feed: 'quadratec', startedAt: new Date('2026-08-06T12:00:05Z') }]);

	await recordScriptRun(prisma, {
		feed: QUADRATEC,
		command: 'seed-quadratec',
		startedAt,
		finishedAt: new Date('2026-08-06T12:01:00Z'),
		status: 'success',
	});

	assert.strictEqual(prisma.created.length, 0, 'the detailed row stays the last one');
});

test('a failure is recorded with its message', async () => {
	const prisma = makePrismaStub();

	await recordScriptRun(prisma, {
		feed: CTP,
		command: 'seed-ctp',
		startedAt: new Date(),
		finishedAt: new Date(),
		status: 'failed',
		error: 'exit code 1',
	});

	assert.strictEqual(prisma.created[0].status, 'failed');
	assert.strictEqual(prisma.created[0].error, 'exit code 1');
});

test('without prisma or without a feed it does nothing', async () => {
	assert.strictEqual(await recordScriptRun(null, { feed: CTP, command: 'seed-ctp' }), null);
	const prisma = makePrismaStub();
	assert.strictEqual(await recordScriptRun(prisma, { feed: null, command: 'whatever' }), null);
	assert.strictEqual(prisma.created.length, 0);
});
