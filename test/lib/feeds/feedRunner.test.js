const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createFeedRunner } = require('../../../lib/feeds/feedRunner');

const FEEDS = {
	getFeedByName: (name) => {
		if (name === 'omix') return { name: 'omix', seedCommand: 'seed-omix' };
		// Pulled from the vendor by FTP, so it also has a manual fetch.
		if (name === 'keystone-ftp') {
			return {
				name: 'keystone-ftp',
				seedCommand: 'seed-keystone-ftp2',
				syncCommands: ['seed-keystone-ftp2', 'seed-keystone-ftp-codes'],
				applyCommand: 'feed-apply-keystone',
				fetchCommand: 'feed-fetch-keystone',
			};
		}
		// A feed may list several scripts, run in sequence.
		if (name === 'quadratec') return { name: 'quadratec', seedCommand: ['seed-quadratec', 'seed-quad-inventory'] };
		// API-sourced: no files, so there is no feed-sync to run first.
		if (name === 'magento-products') return { name: 'magento-products', source: 'api', seedCommand: 'seed-allProducts' };
		if (name === 'warn-map') {
			return { name: 'warn-map', seedCommand: null, seedCommandNote: 'Updates prices on the live store, so it only runs in the daily sync' };
		}
		// Declares its own ceiling, tiny here so the timeout path runs in a test.
		if (name === 'slow-feed') return { name: 'slow-feed', source: 'api', seedCommand: 'seed-slow', runTimeoutMs: 5 };
		// Only talks to the store, so the orders sync may run alongside it.
		if (name === 'store-publish') {
			return { name: 'store-publish', seedCommand: 'publish-store', cronsAllowedDuringRun: ['seed-orders-delta'] };
		}
		return null;
	},
};

function makeFixture({ seedAllRunning = false, seedAllLockAgeMs = 60_000 } = {}) {
	const spawned = [];
	const groupSignals = [];
	const child = () => {
		const proc = new EventEmitter();
		proc.pid = 4242;
		proc.stdout = { pipe: () => {} };
		proc.stderr = { pipe: () => {} };
		proc.kill = () => proc.emit('close', 143);
		return proc;
	};
	let lastChild = null;
	const spawn = (cmd, args, opts) => {
		lastChild = child();
		spawned.push({ cmd, args, env: opts.env, detached: opts.detached });
		return lastChild;
	};
	const fs = {
		existsSync: (p) => (String(p).endsWith('seed-all.lock') ? seedAllRunning : true),
		mkdirSync: () => {},
		writeFileSync: () => {},
		createWriteStream: () => ({}),
		// mtimeMs is what tells a live lock from one left behind by a restart.
		statSync: () => ({ size: 5, mtimeMs: Date.now() - seedAllLockAgeMs }),
	};
	// The log tail is read off the event loop (the panel polls it every 2s).
	const fsp = {
		open: async () => ({
			stat: async () => ({ size: 5 }),
			read: async (buffer) => { buffer.write('done!'); return { bytesRead: 5 }; },
			close: async () => {},
		}),
	};
	// now() must follow the clock here: the lock age is measured against it.
	const killProcessGroup = (pid, signal) => groupSignals.push({ pid, signal });
	const runner = createFeedRunner({ spawn, fs, fsp, feedsConfig: FEEDS, now: () => Date.now(), killProcessGroup });
	return { runner, spawned, groupSignals, getChild: () => lastChild };
}

// Every other test injects stubs for spawn/fs/fsp, so a default parameter that
// referenced a module the file never imported stayed invisible until the API
// booted in production and crashed on require. This builds the runner the way
// services/feeds/runnerInstance.js does, with nothing injected.
test('fetch mode runs the vendor fetch alone, without a feed-sync first', () => {
	// The fetch is what PRODUCES the batch, so syncing before it would sync
	// nothing (and would fail outright on a feed that has no batch yet).
	const fixture = makeFixture();
	const record = fixture.runner.start('keystone-ftp', { startedBy: 'ricardo', mode: 'fetch' });

	assert.strictEqual(fixture.spawned[0].args[1], 'npm run feed-fetch-keystone');
	assert.strictEqual(record.mode, 'fetch');
});

test('fetch mode is refused for a feed nobody fetches', () => {
	const fixture = makeFixture();
	assert.throws(
		() => fixture.runner.start('omix', { mode: 'fetch' }),
		(error) => error.code === 'FEED_RUN_NOT_ALLOWED'
	);
});

test('an API feed runs its seed alone, with no feed-sync first', () => {
	// source: 'api' (the Magento products sync) has no files in the bucket, so
	// a feed-sync would fail on "no batch" for a feed that never has one.
	const fixture = makeFixture();
	const record = fixture.runner.start('magento-products', { startedBy: 'tess' });

	assert.strictEqual(fixture.spawned[0].args[1], 'npm run seed-allProducts');
	assert.strictEqual(record.command, 'seed-allProducts');
});

test('the runner builds with no injected dependencies, as production does', () => {
	assert.doesNotThrow(() => createFeedRunner());
	assert.doesNotThrow(() => createFeedRunner({}));
});

test('start runs the feed-sync for the feed and then the seedCommand, with a heap cap', () => {
	const fixture = makeFixture();
	const record = fixture.runner.start('omix', { startedBy: 'ricardo' });

	// feed-sync BEFORE the seed: without it the seed would read the old symlink
	// and report success with the previous file.
	assert.strictEqual(fixture.spawned[0].cmd, 'sh');
	assert.strictEqual(fixture.spawned[0].args[0], '-c');
	assert.strictEqual(fixture.spawned[0].args[1], 'npm run feed-sync -- omix && npm run seed-omix');
	assert.strictEqual(fixture.spawned[0].env.APP_ROLE, 'seed');
	assert.strictEqual(fixture.spawned[0].env.INGEST_TRIGGER, 'manual');
	// Same heap cap as seed-all (2GB droplet shared with the API).
	assert.match(fixture.spawned[0].env.NODE_OPTIONS, /--max-old-space-size=\d+/);
	assert.strictEqual(record.status, 'running');
	assert.strictEqual(record.startedBy, 'ricardo');
});

test('exit 0 becomes success and exit != 0 becomes failed, with the log tail in the status', async () => {
	const okFixture = makeFixture();
	okFixture.runner.start('omix');
	okFixture.getChild().emit('close', 0);
	const ok = await okFixture.runner.getStatus('omix');
	assert.strictEqual(ok.status, 'success');
	assert.strictEqual(ok.exitCode, 0);
	assert.strictEqual(ok.logTail, 'done!');
	assert.strictEqual(okFixture.runner.isBusy(), false);

	const failFixture = makeFixture();
	failFixture.runner.start('omix');
	failFixture.getChild().emit('close', 1);
	assert.strictEqual((await failFixture.runner.getStatus('omix')).status, 'failed');
});

test('a feed without seedCommand and an unknown feed are rejected', () => {
	const fixture = makeFixture();
	assert.throws(() => fixture.runner.start('warn-map'), (error) =>
		error.code === 'FEED_RUN_NOT_ALLOWED' && /live store/.test(error.message));
	assert.throws(() => fixture.runner.start('does-not-exist'), (error) => error.code === 'FEED_UNKNOWN');
	assert.strictEqual(fixture.spawned.length, 0);
});

test('a second simultaneous run is rejected until the first one finishes', () => {
	const fixture = makeFixture();
	fixture.runner.start('omix');
	assert.throws(() => fixture.runner.start('omix'), (error) => error.code === 'FEED_RUN_BUSY');

	fixture.getChild().emit('close', 0);
	assert.doesNotThrow(() => fixture.runner.start('omix'));
	assert.strictEqual(fixture.spawned.length, 2);
});

test('blocks while seed-all is running (lock file present)', () => {
	const fixture = makeFixture({ seedAllRunning: true });
	assert.throws(() => fixture.runner.start('omix'), (error) =>
		error.code === 'FEED_RUN_BUSY' && /daily vendor sync/i.test(error.message));
	assert.strictEqual(fixture.spawned.length, 0);
});

test('a spawn error marks it failed and releases the slot', async () => {
	const fixture = makeFixture();
	fixture.runner.start('omix');
	fixture.getChild().emit('error', new Error('spawn ENOENT'));
	const status = await fixture.runner.getStatus('omix');
	assert.strictEqual(status.status, 'failed');
	assert.strictEqual(status.error, 'spawn ENOENT');
	assert.strictEqual(fixture.runner.isBusy(), false);
});

test('a feed with several scripts chains them after the sync, in order', () => {
	const fixture = makeFixture();
	fixture.runner.start('quadratec');

	assert.strictEqual(
		fixture.spawned[0].args[1],
		'npm run feed-sync -- quadratec && npm run seed-quadratec && npm run seed-quad-inventory'
	);
});

test('a lock left behind by a restart does not block the button forever', () => {
	// seed-all removes its lock when it ends, which does not happen if the
	// container is replaced mid-run. An old lock must not block Run now.
	const fixture = makeFixture({ seedAllRunning: true, seedAllLockAgeMs: 6 * 60 * 60 * 1000 });

	assert.doesNotThrow(() => fixture.runner.start('omix'));
	assert.strictEqual(fixture.spawned.length, 1);
});

test("blocks while the feed's own scheduled job holds the cron gate, and only that feed", () => {
	const fixture = makeFixture();
	let active = 'feed-apply-keystone';
	fixture.runner.setActiveCronCommand(() => active);

	assert.throws(
		() => fixture.runner.start('keystone-ftp'),
		(error) => error.code === 'FEED_RUN_BUSY' && /feed-apply-keystone/.test(error.message)
	);
	assert.strictEqual(fixture.spawned.length, 0);

	// Another vendor's seed does not share Keystone's staging tables.
	fixture.runner.start('omix');
	assert.strictEqual(fixture.spawned.length, 1);
	fixture.getChild().emit('close', 0);

	// The codes pass is part of the feed's sync as well.
	active = 'seed-keystone-ftp-codes';
	assert.throws(() => fixture.runner.start('keystone-ftp'), (error) => error.code === 'FEED_RUN_BUSY');

	active = null;
	fixture.runner.start('keystone-ftp');
	assert.strictEqual(fixture.spawned.length, 2);
});

// 2026-11-17: the CAD store publish hit its ceiling, the runner killed only the
// `sh` wrapper, and npm + node lived on as orphans for 14 more hours.
test('a timeout signals the whole process group, not only the shell wrapper', async () => {
	const fixture = makeFixture();
	fixture.runner.start('slow-feed', { startedBy: 'tess' });

	await new Promise((resolve) => setTimeout(resolve, 30));

	assert.strictEqual(fixture.spawned[0].detached, true);
	assert.deepStrictEqual(fixture.groupSignals, [{ pid: 4242, signal: 'SIGTERM' }]);
});

// `close` waits for stdout/stderr to end, and a surviving grandchild keeps the
// pipe open: the slot stayed taken and every cron was deferred for 20 hours.
test('the slot is released when the child exits, even if its pipes never close', () => {
	const fixture = makeFixture();
	fixture.runner.start('omix', { startedBy: 'tess' });
	assert.strictEqual(fixture.runner.isBusy(), true);

	fixture.getChild().emit('exit', 0);

	assert.strictEqual(fixture.runner.isBusy(), false);
	assert.strictEqual(fixture.runner.getRun('omix').status, 'success');
});

// The CAD store publish never touches the Order tables, yet it froze the
// 5-minute orders sync for 20 hours (2026-11-17).
test('a running feed defers every cron except the ones it declares safe alongside it', () => {
	const fixture = makeFixture();
	assert.strictEqual(fixture.runner.isBlockingCron('seed-all'), false);

	fixture.runner.start('store-publish', { startedBy: 'tess' });

	assert.strictEqual(fixture.runner.isBlockingCron('seed-orders-delta'), false);
	assert.strictEqual(fixture.runner.isBlockingCron('seed-all'), true);
	fixture.getChild().emit('close', 0);
	assert.strictEqual(fixture.runner.isBlockingCron('seed-all'), false);
});

test('a feed that declares nothing defers every cron, as before', () => {
	const fixture = makeFixture();
	fixture.runner.start('omix', { startedBy: 'tess' });

	assert.strictEqual(fixture.runner.isBlockingCron('seed-orders-delta'), true);
});
