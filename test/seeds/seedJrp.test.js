const test = require('node:test');
const assert = require('node:assert');

// The script loads prisma and the ingest helpers lazily (inside buildDeps),
// so requiring it here touches no database.
const { parseArgs, exitCodeFor, main } = require('../../prisma/seeds/seed-individual/seed-jrp');

function fakeBuild({ configured = true } = {}) {
	const state = { disconnected: 0 };
	const build = () => ({
		prisma: { $disconnect: async () => { state.disconnected += 1; } },
		deps: { store: { isConfigured: () => configured } },
	});
	return { build, state };
}

const quiet = { error: () => {}, info: () => {}, warn: () => {} };

test('parseArgs reads --dry-run and --force', () => {
	assert.deepStrictEqual(parseArgs([]), { dryRun: false, force: false });
	assert.deepStrictEqual(parseArgs(['--dry-run']), { dryRun: true, force: false });
	assert.deepStrictEqual(parseArgs(['--force', '--dry-run']), { dryRun: true, force: true });
});

test('only a failed run exits 1', () => {
	assert.strictEqual(exitCodeFor({ status: 'failed' }), 1);
	for (const status of ['success', 'dry-run', 'skipped-unchanged', 'skipped-locked']) {
		assert.strictEqual(exitCodeFor({ status }), 0, status);
	}
});

test('main passes the options to the ingest and always disconnects', async () => {
	const { build, state } = fakeBuild();
	const calls = [];
	const run = async (deps, options) => { calls.push(options); return { status: 'failed' }; };
	assert.strictEqual(await main(['--dry-run'], { build, run, log: quiet }), 1);
	assert.deepStrictEqual(calls, [{ dryRun: true, force: false }]);
	assert.strictEqual(state.disconnected, 1);
});

test('a real run without Spaces configured exits 1 before ingesting', async () => {
	const { build, state } = fakeBuild({ configured: false });
	let ran = false;
	const run = async () => { ran = true; return { status: 'success' }; };
	assert.strictEqual(await main([], { build, run, log: quiet }), 1);
	assert.strictEqual(ran, false);
	assert.strictEqual(state.disconnected, 1);
});

test('an unexpected throw exits 1', async () => {
	const { build } = fakeBuild();
	const run = async () => { throw new Error('boom'); };
	assert.strictEqual(await main([], { build, run, log: quiet }), 1);
});
