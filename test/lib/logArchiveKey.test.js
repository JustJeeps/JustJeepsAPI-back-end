const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildLogKey,
	resolveSlice,
	truncationHeader,
	slugify,
} = require('../../lib/logArchive/keys');

const AT = new Date('2026-08-07T05:45:12.345Z');

test('buildLogKey lays the run out by source, command and date', () => {
	assert.equal(
		buildLogKey({ command: 'feed-fetch-keystone', startedAt: AT, status: 'failed' }),
		'logs/cron/feed-fetch-keystone/2026/08/07/20260807T054512Z-failed.log'
	);
});

test('buildLogKey honours source, prefix and extension', () => {
	assert.equal(
		buildLogKey({ command: 'seed-all', startedAt: AT, status: 'success', source: 'seed-all', prefix: '/archive/', extension: 'summary.json' }),
		'archive/seed-all/seed-all/2026/08/07/20260807T054512Z-success.summary.json'
	);
});

test('buildLogKey accepts an ISO string and rejects garbage', () => {
	assert.equal(
		buildLogKey({ command: 'seed-omix', startedAt: AT.toISOString(), status: 'failed' }),
		'logs/cron/seed-omix/2026/08/07/20260807T054512Z-failed.log'
	);
	assert.throws(() => buildLogKey({ command: 'x', startedAt: 'not a date', status: 'ok' }), TypeError);
});

// A command name reaches this from config/cron-jobs.js. A key is a path: it
// must not be able to climb out of the prefix.
test('a command name can never escape the prefix', () => {
	const key = buildLogKey({ command: '../../etc/passwd', startedAt: AT, status: 'failed' });
	assert.equal(key, 'logs/cron/etc-passwd/2026/08/07/20260807T054512Z-failed.log');
	assert.ok(!key.includes('..'));
});

test('slugify falls back when nothing usable is left', () => {
	assert.equal(slugify('///', 'unknown'), 'unknown');
	assert.equal(slugify('Daily Vendor Sync', 'x'), 'daily-vendor-sync');
});

test('resolveSlice takes only what the run appended', () => {
	const slice = resolveSlice({ startOffset: 1000, endOffset: 1500, maxBytes: 999999 });
	assert.deepEqual(slice, { skip: false, start: 1000, end: 1499, bytes: 500, truncated: false, omittedBytes: 0 });
});

test('a run that wrote nothing is skipped', () => {
	assert.equal(resolveSlice({ startOffset: 1000, endOffset: 1000 }).skip, true);
	assert.equal(resolveSlice({ startOffset: 0, endOffset: 0 }).skip, true);
});

// Someone rotated or replaced the file mid-run: the old offset points past the
// end, so it means nothing and the whole file is the safer answer.
test('a file that shrank is archived from the beginning', () => {
	const slice = resolveSlice({ startOffset: 5000, endOffset: 300, maxBytes: 999999 });
	assert.deepEqual(slice, { skip: false, start: 0, end: 299, bytes: 300, truncated: false, omittedBytes: 0 });
});

test('an oversized run keeps the tail, where the failure is', () => {
	const slice = resolveSlice({ startOffset: 0, endOffset: 1000, maxBytes: 400 });
	assert.equal(slice.bytes, 400);
	assert.equal(slice.end, 999, 'the slice must end at the last byte of the run');
	assert.equal(slice.start, 600);
	assert.equal(slice.truncated, true);
	assert.equal(slice.omittedBytes, 600);
});

test('the truncation header says how much is missing', () => {
	const header = truncationHeader({ omittedBytes: 600, command: 'seed-meyer', startedAt: AT });
	assert.match(header, /seed-meyer/);
	assert.match(header, /600 bytes were omitted/);
	assert.ok(header.endsWith('\n'));
});
