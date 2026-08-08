const test = require('node:test');
const assert = require('node:assert');

const feedsConfig = require('../../config/feeds');

// The QuickBooks export is not a vendor price file: it carries customer PII and
// financial history, and it reaches the app through the same panel. These are
// the properties the routes rely on to keep it out of everyone else's view.
test('the quickbooks feed is registered and marked restricted', () => {
	const feed = feedsConfig.getFeedByName('quickbooks');

	assert.ok(feed, 'the feed exists in the registry');
	assert.strictEqual(feed.restricted, true);
	assert.deepStrictEqual(feed.files, ['customers_qb_desktop.csv', 'transactions_per_customer.csv']);
	assert.strictEqual(feed.seedCommand, 'seed-quickbooks-customers');
	// Same threshold the freshness cron warns at, so the panel and the daily
	// e-mail never disagree about what counts as old.
	assert.strictEqual(feed.staleAfterHours, 14 * 24);
});

test('every other feed is public to signed-in users', () => {
	const restricted = feedsConfig.getFeedDefinitions()
		.filter((feed) => feed.restricted)
		.map((feed) => feed.name);

	assert.deepStrictEqual(restricted, ['quickbooks']);
});

test('the quickbooks legacy dir follows QB_LOOKUP_DATA_DIR', () => {
	const previous = process.env.QB_LOOKUP_DATA_DIR;
	try {
		process.env.QB_LOOKUP_DATA_DIR = '/data/quickbooks-customers';
		// Absolute on purpose: the lookup reads its own volume, not api-calls.
		assert.strictEqual(feedsConfig.getFeedByName('quickbooks').legacyDir, '/data/quickbooks-customers');

		delete process.env.QB_LOOKUP_DATA_DIR;
		assert.strictEqual(feedsConfig.getFeedByName('quickbooks').legacyDir, 'quickbooks');
	} finally {
		if (previous === undefined) delete process.env.QB_LOOKUP_DATA_DIR;
		else process.env.QB_LOOKUP_DATA_DIR = previous;
	}
});

test('each feed alerts on its own rhythm, not on one global idea of old', () => {
	// Omix is revised about twice a year: alerting sooner would train people to
	// ignore the digest. Keystone is fetched twice a day, so a day and a half is
	// already a problem. The age is shown either way; this only decides when it
	// becomes a complaint.
	const days = (name) => feedsConfig.getFeedByName(name).staleAfterHours / 24;

	assert.strictEqual(days('omix'), 180);
	assert.strictEqual(days('keystone-ftp'), 1.5);
	assert.ok(days('quickbooks') < days('omix'), 'the QuickBooks export is expected far more often');
});
