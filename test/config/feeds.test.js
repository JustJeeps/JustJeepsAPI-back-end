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
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('pricingKit_quad').name, 'quadratec');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('CTPENT_Inventory').name, 'ctp');
	assert.strictEqual(feedsConfig.getFeedByWorkbookBaseName('does-not-exist'), null);
});

test('keystone-ftp requires both FTP files', () => {
	const keystone = feedsConfig.getFeedByName('keystone-ftp');
	assert.deepStrictEqual(keystone.files, ['Inventory.csv', 'SpecialOrder.csv']);
});

test('quadratec requires the CSV, the gold sheet and the gold kit', () => {
	// The kit is required, not optional: seed-quadratec deletes what is missing
	// from the files, so a sheet-only batch would remove every kit row.
	const quadratec = feedsConfig.getFeedByName('quadratec');
	assert.deepStrictEqual(quadratec.files, ['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx', 'pricingKit_quad.xlsx']);
});

test('every file has a spec with a non-empty signature, and files is exactly the spec names', () => {
	for (const feed of feedsConfig.getFeedDefinitions()) {
		assert.ok(Array.isArray(feed.fileSpecs) && feed.fileSpecs.length >= 1, `${feed.name} has no fileSpecs`);
		assert.deepStrictEqual(feed.files, feed.fileSpecs.map((spec) => spec.name), `${feed.name}: files must derive from fileSpecs`);
		for (const spec of feed.fileSpecs) {
			assert.ok(spec.name && spec.label, `${feed.name}/${spec.name} needs a name and a label`);
			assert.ok(Array.isArray(spec.signature) && spec.signature.length >= 1, `${feed.name}/${spec.name} has an empty signature`);
			assert.ok(spec.signature.some((column) => column !== ''), `${feed.name}/${spec.name} signature is all blanks`);
			assert.ok(spec.sheet === null || typeof spec.sheet === 'string', `${feed.name}/${spec.name} sheet must be a string or null`);
			// Stored the way the matcher compares: no stray whitespace to normalize.
			for (const column of spec.signature) {
				assert.strictEqual(column, column.replace(/\s+/g, ' ').trim(), `${feed.name}/${spec.name}: column "${column}" is not normalized`);
			}
		}
		// Leading/trailing blanks would never match a normalized header.
		assert.notStrictEqual(feed.fileSpecs[0].signature[0], '');
	}
});

test('getFileSpec and getAllFileSpecs look specs up by canonical name', () => {
	const kit = feedsConfig.getFileSpec('quadratec', 'pricingKit_quad.xlsx');
	assert.deepStrictEqual(kit.signature, ['Name', 'Display Name', 'Retail Price', 'Wholesale Price', 'Brand']);
	assert.strictEqual(kit.label, 'Quadratec gold kit');
	assert.strictEqual(feedsConfig.getFileSpec(feedsConfig.getFeedByName('keyparts'), 'KeyParts-price-file.xlsx').sheet, 'Price List');
	assert.strictEqual(feedsConfig.getFileSpec('quadratec', 'nope.xlsx'), null);
	assert.strictEqual(feedsConfig.getFileSpec('no-such-feed', 'x'), null);

	const all = feedsConfig.getAllFileSpecs();
	const total = feedsConfig.getFeedDefinitions().reduce((sum, feed) => sum + feed.files.length, 0);
	assert.strictEqual(all.length, total);
	assert.ok(all.every((spec) => spec.feed && spec.fileName && spec.label && Array.isArray(spec.signature)));
});

test('the two Keystone files share a signature and no other pair does', () => {
	const all = feedsConfig.getAllFileSpecs();
	const key = (spec) => JSON.stringify(spec.signature);
	const groups = new Map();
	for (const spec of all) groups.set(key(spec), [...(groups.get(key(spec)) || []), `${spec.feed}/${spec.fileName}`]);
	const shared = [...groups.values()].filter((names) => names.length > 1);
	assert.deepStrictEqual(shared, [['keystone-ftp/Inventory.csv', 'keystone-ftp/SpecialOrder.csv']]);
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
