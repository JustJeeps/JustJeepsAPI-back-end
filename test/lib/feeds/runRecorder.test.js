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

test('a failure the script already filed is not duplicated', async () => {
	// seed-omix files "no such file ... omix-excel.xlsx" itself. A bookkeeping
	// row on top would be newer, so the panel would show "Exit code 1" and hide
	// the only line that says what to do about it.
	const startedAt = new Date('2026-08-07T11:46:00Z');
	const prisma = makePrismaStub([
		{ feed: 'omix', startedAt: new Date('2026-08-07T11:46:02Z'), status: 'failed' },
	]);

	await recordScriptRun(prisma, {
		feed: { name: 'omix', ingestFeed: 'omix' },
		command: 'seed-omix',
		startedAt,
		finishedAt: new Date('2026-08-07T11:46:05Z'),
		status: 'failed',
		error: 'Exit code 1',
	});

	assert.strictEqual(prisma.created.length, 0, 'the reason stays the last word');
});

test('a failure is recorded even when an earlier script of the feed succeeded', async () => {
	const startedAt = new Date('2026-08-06T12:00:00Z');
	// Quadratec runs two scripts: the first recorded its own successful run, the
	// second one failed. Skipping the write here left a green success on screen
	// for a feed whose ingest had actually broken.
	const prisma = makePrismaStub([{ feed: 'quadratec', startedAt: new Date('2026-08-06T12:00:05Z') }]);

	await recordScriptRun(prisma, {
		feed: QUADRATEC,
		command: 'seed-quad-inventory',
		startedAt,
		finishedAt: new Date('2026-08-06T12:02:00Z'),
		status: 'failed',
		error: 'exit code 1',
	});

	assert.strictEqual(prisma.created.length, 1);
	assert.strictEqual(prisma.created[0].status, 'failed');
});

test('a feed whose scripts record their own counts gets no bookkeeping row on success', async () => {
	// Without recordsOwnRuns the zero-count row lands after the detailed one and
	// the panel reads "+0 ~0 -0" for a run that touched hundreds of rows.
	const prisma = makePrismaStub();

	await recordScriptRun(prisma, {
		feed: { name: 'quadratec', ingestFeed: 'quadratec', recordsOwnRuns: true },
		command: 'seed-quadratec',
		startedAt: new Date(),
		finishedAt: new Date(),
		status: 'success',
	});

	assert.strictEqual(prisma.created.length, 0);
});

test('every script the daily sync runs maps to a feed, button or not', () => {
	// update-warn-cad-map-prices has no Run now button on purpose (it writes
	// prices to the live store) and used to map to nothing, so the feed showed
	// "never" while running every night.
	assert.strictEqual(findFeedByCommand('update-warn-cad-map-prices').name, 'warn-map');
	assert.strictEqual(findFeedByCommand('seed-omix-inventory').name, 'omix');
	assert.strictEqual(findFeedByCommand('seed-wheelPros').name, 'wheelpros-inventory');
	assert.strictEqual(findFeedByCommand('seed-keystone-ftp-codes').name, 'keystone-ftp');
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
