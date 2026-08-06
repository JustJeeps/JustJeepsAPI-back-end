const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createFeedRunner } = require('../../../lib/feeds/feedRunner');

const FEEDS = {
	getFeedByName: (name) => {
		if (name === 'omix') return { name: 'omix', seedCommand: 'seed-omix' };
		// A feed may list several scripts, run in sequence.
		if (name === 'quadratec') return { name: 'quadratec', seedCommand: ['seed-quadratec', 'seed-quad-inventory'] };
		if (name === 'warn-map') {
			return { name: 'warn-map', seedCommand: null, seedCommandNote: 'Updates prices on the live store, so it only runs in the daily sync' };
		}
		return null;
	},
};

function makeFixture({ seedAllRunning = false, seedAllLockAgeMs = 60_000 } = {}) {
	const spawned = [];
	const child = () => {
		const proc = new EventEmitter();
		proc.stdout = { pipe: () => {} };
		proc.stderr = { pipe: () => {} };
		proc.kill = () => proc.emit('close', 143);
		return proc;
	};
	let lastChild = null;
	const spawn = (cmd, args, opts) => {
		lastChild = child();
		spawned.push({ cmd, args, env: opts.env });
		return lastChild;
	};
	const fs = {
		existsSync: (p) => (String(p).endsWith('seed-all.lock') ? seedAllRunning : true),
		mkdirSync: () => {},
		writeFileSync: () => {},
		createWriteStream: () => ({}),
		// mtimeMs is what tells a live lock from one left behind by a restart.
		statSync: () => ({ size: 5, mtimeMs: Date.now() - seedAllLockAgeMs }),
		openSync: () => 1,
		readSync: (fd, buffer) => { buffer.write('done!'); return 5; },
		closeSync: () => {},
	};
	// now() must follow the clock here: the lock age is measured against it.
	const runner = createFeedRunner({ spawn, fs, feedsConfig: FEEDS, now: () => Date.now() });
	return { runner, spawned, getChild: () => lastChild };
}

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

test('exit 0 becomes success and exit != 0 becomes failed, with the log tail in the status', () => {
	const okFixture = makeFixture();
	okFixture.runner.start('omix');
	okFixture.getChild().emit('close', 0);
	const ok = okFixture.runner.getStatus('omix');
	assert.strictEqual(ok.status, 'success');
	assert.strictEqual(ok.exitCode, 0);
	assert.strictEqual(ok.logTail, 'done!');
	assert.strictEqual(okFixture.runner.isBusy(), false);

	const failFixture = makeFixture();
	failFixture.runner.start('omix');
	failFixture.getChild().emit('close', 1);
	assert.strictEqual(failFixture.runner.getStatus('omix').status, 'failed');
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

test('a spawn error marks it failed and releases the slot', () => {
	const fixture = makeFixture();
	fixture.runner.start('omix');
	fixture.getChild().emit('error', new Error('spawn ENOENT'));
	const status = fixture.runner.getStatus('omix');
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
