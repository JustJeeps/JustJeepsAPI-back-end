const test = require('node:test');
const assert = require('node:assert');
const {
	getDateStringInTimezone,
	getTrailingDateStringsInTimezone,
} = require('../../../lib/reports/dates');

test('getDateStringInTimezone formats en-CA YYYY-MM-DD in the given timezone', () => {
	assert.strictEqual(
		getDateStringInTimezone(new Date('2026-07-15T12:00:00Z'), 'America/Toronto'),
		'2026-07-15'
	);
});

test('getDateStringInTimezone respects the timezone across the date boundary', () => {
	// 02:00Z is 22:00 previous day in Toronto (EDT, -04)
	assert.strictEqual(
		getDateStringInTimezone(new Date('2026-07-15T02:00:00Z'), 'America/Toronto'),
		'2026-07-14'
	);
});

test('getDateStringInTimezone returns empty string for invalid dates', () => {
	assert.strictEqual(getDateStringInTimezone(new Date('not-a-date'), 'America/Toronto'), '');
});

test('getDateStringInTimezone accepts string input', () => {
	assert.strictEqual(
		getDateStringInTimezone('2026-07-15T12:00:00Z', 'America/Toronto'),
		'2026-07-15'
	);
});

test('getTrailingDateStringsInTimezone returns N ascending dates ending at the given date', () => {
	assert.deepStrictEqual(
		getTrailingDateStringsInTimezone(new Date('2026-07-15T12:00:00Z'), 3, 'America/Toronto'),
		['2026-07-13', '2026-07-14', '2026-07-15']
	);
});
