const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLegacySync, ensureLink } = require('../../../lib/feeds/legacySync');

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDirs() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'legacysync-'));
	const apiCallsDir = path.join(base, 'api-calls');
	const cacheDir = path.join(base, 'cache');
	fs.mkdirSync(apiCallsDir, { recursive: true });
	fs.mkdirSync(cacheDir, { recursive: true });
	return { apiCallsDir, cacheDir };
}

function typed(code, message) {
	const error = new Error(message || code);
	error.code = code;
	return error;
}

test('ensureLink creates the symlink, is a no-op when it already points to the right target and swaps atomically when it changes', () => {
	const { apiCallsDir, cacheDir } = makeDirs();
	const target1 = path.join(cacheDir, 'batch-1-Inventory.csv');
	const target2 = path.join(cacheDir, 'batch-2-Inventory.csv');
	fs.writeFileSync(target1, 'v1');
	fs.writeFileSync(target2, 'v2');
	const linkPath = path.join(apiCallsDir, 'keystone_files', 'Inventory.csv');

	assert.strictEqual(ensureLink(linkPath, target1), true, 'creates');
	assert.strictEqual(fs.readFileSync(linkPath, 'utf8'), 'v1');

	assert.strictEqual(ensureLink(linkPath, target1), false, 'no-op');

	assert.strictEqual(ensureLink(linkPath, target2), true, 'swaps');
	assert.strictEqual(fs.readFileSync(linkPath, 'utf8'), 'v2');
	assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
});

test('ensureLink replaces a pre-existing REGULAR file (baked into the image)', () => {
	const { apiCallsDir, cacheDir } = makeDirs();
	const target = path.join(cacheDir, 'CTPENT_Inventory.csv');
	fs.writeFileSync(target, 'from the bucket');
	const linkPath = path.join(apiCallsDir, 'CTPENT_Inventory.csv');
	fs.writeFileSync(linkPath, 'old baked file');

	assert.strictEqual(ensureLink(linkPath, target), true);
	assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
	assert.strictEqual(fs.readFileSync(linkPath, 'utf8'), 'from the bucket');
});

test('syncAllFeeds: no batch becomes skipped, a store failure becomes failed, and one does not block the other', async () => {
	const { apiCallsDir, cacheDir } = makeDirs();
	const okFile = path.join(cacheDir, 'WARN-MAP.xlsx');
	fs.writeFileSync(okFile, 'spreadsheet');

	const feedsConfig = {
		getFeedDefinitions: () => [
			{ name: 'warn-map', files: ['WARN-MAP.xlsx'], legacyDir: '' },
			{ name: 'omix', files: ['omix-excel.xlsx'], legacyDir: '' },
			{ name: 'ctp', files: ['CTPENT_Inventory.csv'], legacyDir: '' },
		],
	};
	const materializer = {
		materializeFeed: async (name) => {
			if (name === 'warn-map') {
				return { batchId: 'b1', stale: false, files: { 'WARN-MAP.xlsx': okFile } };
			}
			if (name === 'omix') throw typed('FEED_NO_ARTIFACT', 'no batch');
			throw typed('FEED_STORE_UNAVAILABLE', 'spaces down');
		},
	};

	const sync = createLegacySync({ materializer, feedsConfig, apiCallsDir, logger: quietLogger });
	const result = await sync.syncAllFeeds();

	assert.deepStrictEqual(result.synced.map((s) => s.feed), ['warn-map']);
	assert.deepStrictEqual(result.skipped.map((s) => s.feed), ['omix']);
	assert.deepStrictEqual(result.failed.map((s) => s.feed), ['ctp']);
	assert.strictEqual(fs.readFileSync(path.join(apiCallsDir, 'WARN-MAP.xlsx'), 'utf8'), 'spreadsheet');
	assert.ok(!fs.existsSync(path.join(apiCallsDir, 'omix-excel.xlsx')), 'skipped creates nothing');
});

test('quarantined batch: our link is removed so the seed fails loudly; a plain file stays', async () => {
	const { apiCallsDir, cacheDir } = makeDirs();
	const cached = path.join(cacheDir, 'ctp', 'bad-batch', 'CTPENT_Inventory.csv');
	fs.mkdirSync(path.dirname(cached), { recursive: true });
	fs.writeFileSync(cached, 'condemned data');

	// ctp points to the condemned batch (our symlink); aev has a plain file.
	const ctpLink = path.join(apiCallsDir, 'CTPENT_Inventory.csv');
	fs.symlinkSync(cached, ctpLink);
	const aevFile = path.join(apiCallsDir, 'AEV-price-file.xlsx');
	fs.writeFileSync(aevFile, 'spreadsheet from the image');

	const feedsConfig = {
		getFeedDefinitions: () => [
			{ name: 'ctp', files: ['CTPENT_Inventory.csv'], legacyDir: '' },
			{ name: 'aev', files: ['AEV-price-file.xlsx'], legacyDir: '' },
		],
	};
	const materializer = { materializeFeed: async () => { throw typed('FEED_NO_ARTIFACT', 'no batch'); } };
	const sync = createLegacySync({ materializer, feedsConfig, apiCallsDir, cacheDir, logger: quietLogger });

	const result = await sync.syncAllFeeds();

	assert.strictEqual(result.skipped.length, 2);
	assert.ok(!fs.existsSync(ctpLink), 'a link to a quarantined batch goes out of circulation');
	assert.strictEqual(fs.readFileSync(aevFile, 'utf8'), 'spreadsheet from the image', 'a plain file is not touched');
});

test('syncFeed respects legacyDir (keystone_files) and reports changed per file', async () => {
	const { apiCallsDir, cacheDir } = makeDirs();
	const inv = path.join(cacheDir, 'Inventory.csv');
	const spec = path.join(cacheDir, 'SpecialOrder.csv');
	fs.writeFileSync(inv, 'inv');
	fs.writeFileSync(spec, 'spec');

	const feed = { name: 'keystone-ftp', files: ['Inventory.csv', 'SpecialOrder.csv'], legacyDir: 'keystone_files' };
	const materializer = {
		materializeFeed: async () => ({
			batchId: 'b9',
			stale: false,
			files: { 'Inventory.csv': inv, 'SpecialOrder.csv': spec },
		}),
	};

	const sync = createLegacySync({ materializer, feedsConfig: { getFeedDefinitions: () => [feed] }, apiCallsDir, logger: quietLogger });
	const result = await sync.syncFeed(feed);

	assert.strictEqual(result.links.every((link) => link.changed), true);
	assert.strictEqual(
		fs.readFileSync(path.join(apiCallsDir, 'keystone_files', 'SpecialOrder.csv'), 'utf8'),
		'spec'
	);

	// Second round with the same batch: nothing changes.
	const again = await sync.syncFeed(feed);
	assert.strictEqual(again.links.every((link) => link.changed === false), true);
});
