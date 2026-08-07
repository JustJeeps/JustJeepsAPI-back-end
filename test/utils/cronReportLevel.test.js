const test = require('node:test');
const assert = require('node:assert');

const { buildCronReportMessage } = require('../../utils/emailService');

// This is about what the message SAYS. A warning was going out labelled
// "Failed", with the job's own log recording exit code 0 for the same event,
// and a daily false alarm is how a real one stops being read.
const freshnessReport = (extra) => buildCronReportMessage({
	jobName: 'QuickBooks Data Freshness Check',
	success: false,
	error: 'QuickBooks lookup data is 21.7 days old',
	duration: '1s',
	results: [{ cmd: 'report-quickbooks-freshness', success: false, durationMs: 800 }],
	now: new Date('2026-08-07T13:15:00Z'),
	...extra,
});

test('a warning is labelled Warning, not Failed', () => {
	const message = freshnessReport({ level: 'warning', exitCode: 0 });

	assert.match(message.subject, /Warning/);
	assert.doesNotMatch(message.subject, /Failed/);
	assert.match(message.text, /Status: Warning/);
	assert.match(message.text, /WARNING \(0\.8s\)/);
	assert.match(message.html, /Warning/);
	assert.doesNotMatch(message.html, /Job Completed with Failures/);
});

test('past the critical threshold it is still a failure', () => {
	const message = freshnessReport({ level: 'failed', exitCode: 1 });

	assert.match(message.subject, /Some Failed/);
	assert.match(message.text, /Status: Failed/);
	assert.match(message.text, /FAILED \(0\.8s\)/);
});

test('a caller that says nothing about level keeps the old behaviour', () => {
	const ok = buildCronReportMessage({
		jobName: 'Daily Vendor Sync',
		success: true,
		exitCode: 0,
		duration: '25m',
		results: [{ cmd: 'seed-all', success: true, durationMs: 1500000 }],
	});
	assert.match(ok.subject, /All Completed/);
	assert.match(ok.text, /Status: Success/);

	const bad = buildCronReportMessage({
		jobName: 'Daily Vendor Sync',
		success: false,
		exitCode: 1,
		duration: '25m',
		results: [{ cmd: 'seed-all', success: false, durationMs: 1500000, error: 'exit code 1' }],
	});
	assert.match(bad.subject, /Some Failed/);
	assert.match(bad.text, /Status: Failed/);
});
