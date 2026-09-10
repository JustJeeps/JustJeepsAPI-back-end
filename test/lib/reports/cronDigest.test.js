const test = require('node:test');
const assert = require('node:assert');

const { summarizeCronDigestEntries } = require('../../../lib/reports/cronDigest.js');

const entry = (command, status, finishedAt, extra = {}) => ({
	command,
	jobName: extra.jobName || command,
	status,
	finishedAt,
	durationMs: extra.durationMs ?? 1000,
	error: 'error' in extra ? extra.error : (status === 'failed' ? 'Process ended with exit code 1' : null),
});

test('a job whose latest run succeeded is not reported as failed, even if an earlier run failed', () => {
	const results = summarizeCronDigestEntries([
		entry('seed-all', 'failed', '2026-09-09T13:37:46Z', { durationMs: 7545000, error: 'Failed steps: seed-allProducts [code 137]' }),
		entry('seed-all', 'success', '2026-09-09T23:59:47Z', { durationMs: 1666000 }),
	]);

	assert.strictEqual(results.length, 1);
	assert.strictEqual(results[0].success, true);
	assert.strictEqual(results[0].error, null);
	assert.strictEqual(results[0].cmd, 'seed-all (2 runs)');
	assert.strictEqual(results[0].durationMs, 7545000 + 1666000);
	assert.match(results[0].logExcerpt, /1 succeeded, 1 failed/);
	assert.match(results[0].logExcerpt, /recovered/i);
});

test('order of entries does not matter: the latest by timestamp decides', () => {
	const results = summarizeCronDigestEntries([
		entry('seed-all', 'success', '2026-09-09T23:59:47Z'),
		entry('seed-all', 'failed', '2026-09-09T13:37:46Z'),
	]);
	assert.strictEqual(results[0].success, true);
});

test('a job whose latest run failed is reported as failed with its errors', () => {
	const results = summarizeCronDigestEntries([
		entry('seed-orders-delta', 'success', '2026-09-09T06:10:00Z'),
		entry('seed-orders-delta', 'failed', '2026-09-09T06:20:06Z', { error: 'Process ended with exit code 1' }),
	]);
	assert.strictEqual(results[0].success, false);
	assert.strictEqual(results[0].error, 'Process ended with exit code 1');
	assert.match(results[0].logExcerpt, /1 succeeded, 1 failed/);
});

test('a job whose latest run was interrupted is reported as failed', () => {
	const results = summarizeCronDigestEntries([
		entry('seed-all', 'success', '2026-09-09T13:00:00Z'),
		entry('seed-all', 'interrupted', '2026-09-09T23:00:00Z', { error: null }),
	]);
	assert.strictEqual(results[0].success, false);
	assert.strictEqual(results[0].error, 'One or more runs did not complete successfully');
});

test('a skipped latest run does not hide an earlier failure that was never re-run successfully', () => {
	const results = summarizeCronDigestEntries([
		entry('feed-fetch-keystone', 'failed', '2026-09-09T10:00:00Z', { error: 'boom' }),
		entry('feed-fetch-keystone', 'skipped', '2026-09-09T10:05:00Z', { error: null }),
	]);
	assert.strictEqual(results[0].success, false);
	assert.strictEqual(results[0].error, 'boom');
});

test('jobs are sorted by name and per-job counters are kept', () => {
	const results = summarizeCronDigestEntries([
		entry('zeta', 'success', '2026-09-09T10:00:00Z', { jobName: 'Zeta Job' }),
		entry('alpha', 'skipped', '2026-09-09T10:00:00Z', { jobName: 'Alpha Job' }),
		entry('alpha', 'success', '2026-09-09T11:00:00Z', { jobName: 'Alpha Job' }),
	]);
	assert.deepStrictEqual(results.map((r) => r.cmd), ['Alpha Job (2 runs)', 'Zeta Job (1 runs)']);
	assert.strictEqual(results[0].logExcerpt, '1 succeeded, 0 failed, 1 skipped, 0 interrupted');
	assert.strictEqual(results[0].logFile, null);
});
