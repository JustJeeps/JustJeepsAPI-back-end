const test = require('node:test');
const assert = require('node:assert');

// Safe to require: the CLI wiring only runs when the file is the entry point.
const { runSeedNiagara, parseArgs } = require('../../prisma/seeds/seed-individual/seed-niagara');

const silent = { info() {}, warn() {}, error() {} };
const item = { jjPrefix: 'BIL', competitorSku: 'BIL-1', price: 10, available: true, url: 'https://niagarajeeps.ca/products/x' };
const payload = (extra = {}) => ({ schemaVersion: 1, source: 'niagara', items: [item], collection: { brandsOk: 1, partial: false }, ...extra });

function makeDeps({ argv = [], collected = payload(), ingestResult, ingestError, lastRun = { sourceRowCount: 900 } } = {}) {
	const calls = { startRun: [], finish: [], ingest: [], archive: [], files: {}, collect: [], prismaOpened: 0 };
	const prisma = { ingestRun: { findFirst: async () => lastRun } };
	return {
		calls,
		deps: {
			argv, env: { INGEST_TRIGGER: 'cron' }, logger: silent, now: () => new Date('2026-11-02T23:00:00Z'), baseUrl: 'https://niagarajeeps.ca',
			brands: [{ jjPrefix: 'BIL', handle: 'bilstein', skuPrefixes: [] }],
			filterBrands: (brands, wanted) => (wanted.length ? brands.filter((b) => wanted.includes(b.jjPrefix)) : brands),
			snapshotFileName: ({ runId, dryRun, sample }) => `snap-${runId}${dryRun ? '-dry' : ''}${sample ? '-sample' : ''}.json`,
			validateSnapshot: (p) => p,
			buildReportCsv: () => 'list\n',
			snapshotDir: '/snap',
			readFile: () => JSON.stringify(payload({ fromFile: true })),
			writeFile: (file, body) => { calls.files[file] = body; },
			collect: async (input) => { calls.collect.push(input); return { payload: collected, invalidSample: [] }; },
			getPrisma: () => { calls.prismaOpened += 1; return prisma; },
			startRun: async (feed, opts) => { calls.startRun.push({ feed, ...opts }); return { id: 42, finish: async (o) => { calls.finish.push(o); } }; },
			ingest: async (input) => {
				calls.ingest.push(input);
				if (ingestError) throw ingestError;
				return ingestResult || { matched: 1, matchRate: 1, counts: { inserted: 1, updated: 0, unchanged: 0, deleted: 0, skipped: 0, markedStale: 3 }, report: { unmatched: [], collisions: [], ambiguous: [] } };
			},
			archive: async (input) => { calls.archive.push(input); return { archived: true, key: input.filePath }; },
		},
	};
}

test('parseArgs reads every mode and rejects unknown flags', () => {
	assert.deepStrictEqual(parseArgs(['--dry-run', '--brands=BIL, RC', '--max-pages=2']), { dryRun: true, collectOnly: false, brands: ['BIL', 'RC'], maxPages: 2, fromSnapshot: null });
	assert.strictEqual(parseArgs(['--from-snapshot', 'a.json']).fromSnapshot, 'a.json');
	assert.throws(() => parseArgs(['--force']), /unknown argument/);
	assert.throws(() => parseArgs(['--collect-only', '--dry-run']), /cannot be combined/);
});

test('parseArgs refuses values that would silently widen a sample into a full run', () => {
	assert.throws(() => parseArgs(['--brands=']), /--brands needs at least one prefix/);
	assert.throws(() => parseArgs(['--brands=, ,']), /--brands needs at least one prefix/);
	assert.throws(() => parseArgs(['--max-pages=abc']), /--max-pages must be a whole number/);
	assert.throws(() => parseArgs(['--max-pages=1.5']), /--max-pages must be a whole number/);
	assert.throws(() => parseArgs(['--max-pages=0']), /--max-pages must be a whole number/);
	assert.throws(() => parseArgs(['--from-snapshot']), /--from-snapshot needs a file/);
	assert.throws(() => parseArgs(['--from-snapshot=']), /--from-snapshot needs a file/);
	assert.throws(() => parseArgs(['--from-snapshot', '--dry-run']), /--from-snapshot needs a file/);
});

test('--collect-only collects and saves a snapshot without ever opening the database', async () => {
	const { deps, calls } = makeDeps({ argv: ['--collect-only', '--brands=BIL', '--max-pages=1'] });
	const result = await runSeedNiagara(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.strictEqual(calls.prismaOpened, 0);
	assert.deepStrictEqual(calls.startRun, []);
	assert.deepStrictEqual(calls.collect[0].sample, { brands: ['BIL'], maxPages: 1 });
	assert.ok(calls.files['/snap/snap-null-sample.json'] || calls.files['/snap/snap-null.json']);
});

test('a full run records the run, ingests against the last full run and archives snapshot and report', async () => {
	const { deps, calls } = makeDeps();
	const result = await runSeedNiagara(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(calls.startRun[0], { feed: 'niagara', sourceKind: 'api', sourceRef: 'https://niagarajeeps.ca', startedBy: 'cron' });
	assert.strictEqual(calls.ingest[0].baselineRows, 900);
	assert.strictEqual(calls.ingest[0].dryRun, false);
	assert.deepStrictEqual(calls.finish[0], { status: 'success', counts: { inserted: 1, updated: 0, unchanged: 0, deleted: 0, skipped: 0, markedStale: 3 }, sourceRowCount: 1 });
	assert.ok(calls.files['/snap/latest-snapshot.json'], 'a full success refreshes latest-snapshot.json');
	assert.deepStrictEqual(calls.archive.map((a) => a.extension), ['json', 'csv']);
});

test('a dry run records status dry-run, archives nothing and keeps latest-snapshot.json', async () => {
	const { deps, calls } = makeDeps({ argv: ['--dry-run'] });
	await runSeedNiagara(deps);
	assert.strictEqual(calls.startRun[0].startedBy, 'dry-run');
	assert.strictEqual(calls.finish[0].status, 'dry-run');
	assert.strictEqual(calls.ingest[0].dryRun, true);
	assert.deepStrictEqual(calls.archive, []);
	assert.strictEqual(calls.files['/snap/latest-snapshot.json'], undefined);
});

test('a sample run is labelled sample and never becomes latest-snapshot.json', async () => {
	const { deps, calls } = makeDeps({ argv: ['--brands=BIL'] });
	await runSeedNiagara(deps);
	assert.strictEqual(calls.startRun[0].startedBy, 'sample');
	assert.match(calls.startRun[0].sourceRef, /\(sample\)/);
	assert.strictEqual(calls.files['/snap/latest-snapshot.json'], undefined);
});

test('a partial crawl writes, records partial and exits 2', async () => {
	const { deps, calls } = makeDeps({ collected: payload({ collection: { brandsOk: 1, partial: true } }) });
	const result = await runSeedNiagara(deps);
	assert.strictEqual(result.exitCode, 2);
	assert.strictEqual(calls.finish[0].status, 'partial');
	assert.strictEqual(calls.files['/snap/latest-snapshot.json'], undefined);
});

test('a guard failure records the run as failed and exits 1', async () => {
	const error = Object.assign(new Error('NIAGARA_MATCH_GUARD: matched 1, under 0.8 of the last full run (900)'), { code: 'NIAGARA_MATCH_GUARD' });
	const { deps, calls } = makeDeps({ ingestError: error });
	const result = await runSeedNiagara(deps);
	assert.strictEqual(result.exitCode, 1);
	assert.strictEqual(calls.finish[0].status, 'failed');
	assert.match(calls.finish[0].error, /NIAGARA_MATCH_GUARD/);
});

test('--from-snapshot ingests the file without collecting', async () => {
	const { deps, calls } = makeDeps({ argv: ['--from-snapshot', '/tmp/x.json'] });
	await runSeedNiagara(deps);
	assert.deepStrictEqual(calls.collect, []);
	assert.strictEqual(calls.startRun[0].sourceKind, 'snapshot');
	assert.strictEqual(calls.ingest[0].payload.fromFile, true);
});

test('a bad argument fails before any run is recorded', async () => {
	const { deps, calls } = makeDeps({ argv: ['--nope'] });
	assert.strictEqual((await runSeedNiagara(deps)).exitCode, 1);
	assert.deepStrictEqual(calls.startRun, []);
});

test('a saved sample replayed with --from-snapshot stays a sample and never sets the baseline', async () => {
	const { deps, calls } = makeDeps({ argv: ['--from-snapshot', '/tmp/x.json'] });
	deps.readFile = () => JSON.stringify(payload({ sample: { brands: ['BIL'], maxPages: 1 } }));
	await runSeedNiagara(deps);
	assert.strictEqual(calls.startRun[0].startedBy, 'sample');
	assert.strictEqual(calls.files['/snap/latest-snapshot.json'], undefined);
});

test('a file write failing after the database write keeps the run a success', async () => {
	const { deps, calls } = makeDeps();
	deps.writeFile = () => { throw new Error('ENOSPC: no space left on device'); };
	const result = await runSeedNiagara(deps);
	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(calls.finish.map((f) => f.status), ['success']);
	assert.deepStrictEqual(calls.archive, []);
});

test('an unreadable snapshot fails before any run is recorded', async () => {
	const { deps, calls } = makeDeps({ argv: ['--from-snapshot', '/tmp/x.json'] });
	deps.readFile = () => 'not json';
	assert.strictEqual((await runSeedNiagara(deps)).exitCode, 1);
	assert.deepStrictEqual(calls.startRun, []);
});
