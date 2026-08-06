const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createFeedRunner } = require('../../../lib/feeds/feedRunner');

const FEEDS = {
	getFeedByName: (name) => {
		if (name === 'omix') return { name: 'omix', seedCommand: 'seed-omix' };
		if (name === 'warn-map') {
			return { name: 'warn-map', seedCommand: null, seedCommandNote: 'Updates prices on the live store, so it only runs in the daily sync' };
		}
		return null;
	},
};

function makeFixture({ seedAllRunning = false } = {}) {
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
		statSync: () => ({ size: 5 }),
		openSync: () => 1,
		readSync: (fd, buffer) => { buffer.write('done!'); return 5; },
		closeSync: () => {},
	};
	const runner = createFeedRunner({ spawn, fs, feedsConfig: FEEDS, now: () => 1000 });
	return { runner, spawned, getChild: () => lastChild };
}

test('start roda feed-sync do feed e depois o seedCommand, com heap cap', () => {
	const fixture = makeFixture();
	const record = fixture.runner.start('omix', { startedBy: 'ricardo' });

	// feed-sync ANTES do seed: sem isso o seed leria o symlink antigo e
	// reportaria sucesso com o arquivo anterior.
	assert.strictEqual(fixture.spawned[0].cmd, 'sh');
	assert.strictEqual(fixture.spawned[0].args[0], '-c');
	assert.strictEqual(fixture.spawned[0].args[1], 'npm run feed-sync -- omix && npm run seed-omix');
	assert.strictEqual(fixture.spawned[0].env.APP_ROLE, 'seed');
	assert.strictEqual(fixture.spawned[0].env.INGEST_TRIGGER, 'manual');
	// Mesmo teto de heap do seed-all (droplet de 2GB compartilhado com a API).
	assert.match(fixture.spawned[0].env.NODE_OPTIONS, /--max-old-space-size=\d+/);
	assert.strictEqual(record.status, 'running');
	assert.strictEqual(record.startedBy, 'ricardo');
});

test('exit 0 vira success e exit != 0 vira failed, com log tail no status', () => {
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

test('feed sem seedCommand e feed desconhecido sao recusados', () => {
	const fixture = makeFixture();
	assert.throws(() => fixture.runner.start('warn-map'), (error) =>
		error.code === 'FEED_RUN_NOT_ALLOWED' && /live store/.test(error.message));
	assert.throws(() => fixture.runner.start('nao-existe'), (error) => error.code === 'FEED_UNKNOWN');
	assert.strictEqual(fixture.spawned.length, 0);
});

test('segunda execucao simultanea e recusada ate a primeira terminar', () => {
	const fixture = makeFixture();
	fixture.runner.start('omix');
	assert.throws(() => fixture.runner.start('omix'), (error) => error.code === 'FEED_RUN_BUSY');

	fixture.getChild().emit('close', 0);
	assert.doesNotThrow(() => fixture.runner.start('omix'));
	assert.strictEqual(fixture.spawned.length, 2);
});

test('bloqueia enquanto o seed-all esta rodando (lock file presente)', () => {
	const fixture = makeFixture({ seedAllRunning: true });
	assert.throws(() => fixture.runner.start('omix'), (error) =>
		error.code === 'FEED_RUN_BUSY' && /daily vendor sync/i.test(error.message));
	assert.strictEqual(fixture.spawned.length, 0);
});

test('erro ao spawnar marca failed e libera o slot', () => {
	const fixture = makeFixture();
	fixture.runner.start('omix');
	fixture.getChild().emit('error', new Error('spawn ENOENT'));
	const status = fixture.runner.getStatus('omix');
	assert.strictEqual(status.status, 'failed');
	assert.strictEqual(status.error, 'spawn ENOENT');
	assert.strictEqual(fixture.runner.isBusy(), false);
});
