const test = require('node:test');
const assert = require('node:assert');

const JRP_ENV_NAMES = [
	'CRON_FEED_FETCH_JRP_ENABLED',
	'CRON_FEED_FETCH_JRP_SCHEDULE',
	'CRON_FEED_APPLY_JRP_ENABLED',
	'CRON_FEED_APPLY_JRP_SCHEDULE',
];

// config/cron-jobs.js reads env at load, so each case loads a fresh copy.
function loadCronJobs(env) {
	const saved = Object.fromEntries(JRP_ENV_NAMES.map((name) => [name, process.env[name]]));
	JRP_ENV_NAMES.forEach((name) => delete process.env[name]);
	Object.assign(process.env, env);
	const modulePath = require.resolve('../../config/cron-jobs');
	delete require.cache[modulePath];
	try {
		return require(modulePath);
	} finally {
		JRP_ENV_NAMES.forEach((name) => {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		});
		delete require.cache[modulePath];
	}
}

function findJob(cronJobs, command) {
	return cronJobs.getCronJobDefinitions({ includeDisabled: true }).find((job) => job.command === command);
}

test('JRP fetch and apply crons are off by default with their default schedules', () => {
	const cronJobs = loadCronJobs({});
	const fetchJob = findJob(cronJobs, 'feed-fetch-jrp');
	const applyJob = findJob(cronJobs, 'feed-apply-jrp');

	assert.strictEqual(fetchJob.enabled, false);
	assert.strictEqual(fetchJob.schedule, '20 9 * * *');
	assert.strictEqual(fetchJob.reportLogFile, 'logs/feed-fetch-jrp.log');
	assert.strictEqual(applyJob.enabled, false);
	assert.strictEqual(applyJob.schedule, '50 9 * * *');
	assert.strictEqual(applyJob.reportLogFile, 'logs/feed-apply-jrp.log');
	const enabledCommands = cronJobs.getCronJobDefinitions().map((job) => job.command);
	assert.ok(!enabledCommands.includes('feed-fetch-jrp'));
	assert.ok(!enabledCommands.includes('feed-apply-jrp'));
});

test('JRP crons turn on only with the exact value true and honour schedule overrides', () => {
	const cronJobs = loadCronJobs({
		CRON_FEED_FETCH_JRP_ENABLED: 'true',
		CRON_FEED_FETCH_JRP_SCHEDULE: '25 9 * * *',
		CRON_FEED_APPLY_JRP_ENABLED: 'yes',
	});

	assert.strictEqual(findJob(cronJobs, 'feed-fetch-jrp').enabled, true);
	assert.strictEqual(findJob(cronJobs, 'feed-fetch-jrp').schedule, '25 9 * * *');
	assert.strictEqual(findJob(cronJobs, 'feed-apply-jrp').enabled, false);
});
