const test = require('node:test');
const assert = require('node:assert');

const feedsConfig = require('../../config/feeds');

test('feed registry has unique names and defined files', () => {
	const feeds = feedsConfig.getFeedDefinitions();
	assert.ok(feeds.length >= 8);

	const names = feeds.map((feed) => feed.name);
	assert.strictEqual(new Set(names).size, names.length);

	for (const feed of feeds) {
		assert.ok(Array.isArray(feed.files) && feed.files.length >= 1, `${feed.name} has no files`);
		assert.ok(Number.isFinite(feed.staleAfterHours) && feed.staleAfterHours > 0);
		assert.ok(Number.isFinite(feed.maxUploadBytes) && feed.maxUploadBytes > 0);
	}
});

test('workbookBaseName is unique and resolves the matching feed', () => {
	const feeds = feedsConfig.getFeedDefinitions();
	const baseNames = feeds.flatMap((feed) => [feed.workbookBaseName, ...(feed.workbookBaseNames || [])]).filter(Boolean);
	assert.strictEqual(new Set(baseNames).size, baseNames.length);

	// One vendor, two workbooks: both resolve to the same feed.
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('quadratec_wholesale').name, 'quadratec');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('pricingSheet_quad').name, 'quadratec');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('CTPENT_Inventory').name, 'ctp');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('does-not-exist'), null);
});

test('keystone-ftp requires both FTP files', () => {
	const keystone = feedsConfig.getFeedByName('keystone-ftp');
	assert.deepStrictEqual(keystone.files, ['Inventory.csv', 'SpecialOrder.csv']);
});

test('FEED_STALE_HOURS_<NAME> overrides the threshold', () => {
	process.env.FEED_STALE_HOURS_KEYSTONE_FTP = '48';
	try {
		assert.strictEqual(feedsConfig.getFeedByName('keystone-ftp').staleAfterHours, 48);
	} finally {
		delete process.env.FEED_STALE_HOURS_KEYSTONE_FTP;
	}
	assert.strictEqual(feedsConfig.getFeedByName('keystone-ftp').staleAfterHours, 36);
});
