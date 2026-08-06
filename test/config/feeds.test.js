const test = require('node:test');
const assert = require('node:assert');

const feedsConfig = require('../../config/feeds');

test('registro de feeds tem nomes unicos e arquivos definidos', () => {
	const feeds = feedsConfig.getFeedDefinitions();
	assert.ok(feeds.length >= 8);

	const names = feeds.map((feed) => feed.name);
	assert.strictEqual(new Set(names).size, names.length);

	for (const feed of feeds) {
		assert.ok(Array.isArray(feed.files) && feed.files.length >= 1, `${feed.name} sem files`);
		assert.ok(Number.isFinite(feed.staleAfterHours) && feed.staleAfterHours > 0);
		assert.ok(Number.isFinite(feed.maxUploadBytes) && feed.maxUploadBytes > 0);
	}
});

test('workbookBaseName e unico e resolve o feed correspondente', () => {
	const feeds = feedsConfig.getFeedDefinitions();
	const baseNames = feeds.map((feed) => feed.workbookBaseName).filter(Boolean);
	assert.strictEqual(new Set(baseNames).size, baseNames.length);

	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('quadratec_wholesale').name, 'quadratec-wholesale');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('CTPENT_Inventory').name, 'ctp');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('nao-existe'), null);
});

test('keystone-ftp exige os dois arquivos do FTP', () => {
	const keystone = feedsConfig.getFeedByName('keystone-ftp');
	assert.deepStrictEqual(keystone.files, ['Inventory.csv', 'SpecialOrder.csv']);
});

test('FEED_STALE_HOURS_<NOME> sobrescreve o threshold', () => {
	process.env.FEED_STALE_HOURS_KEYSTONE_FTP = '48';
	try {
		assert.strictEqual(feedsConfig.getFeedByName('keystone-ftp').staleAfterHours, 48);
	} finally {
		delete process.env.FEED_STALE_HOURS_KEYSTONE_FTP;
	}
	assert.strictEqual(feedsConfig.getFeedByName('keystone-ftp').staleAfterHours, 36);
});
