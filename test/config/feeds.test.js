const test = require('node:test');
const assert = require('node:assert');

const feedsConfig = require('../../config/feeds');

test('feed registry has unique names and defined files', () => {
	const feeds = feedsConfig.getFeedDefinitions();
	assert.ok(feeds.length >= 8);

	const names = feeds.map((feed) => feed.name);
	assert.strictEqual(new Set(names).size, names.length);

	for (const feed of feeds) {
		if (feed.source === 'api') {
			assert.ok(Array.isArray(feed.files) && feed.files.length === 0, `${feed.name} is API-sourced and must have no files`);
		} else {
			assert.ok(Array.isArray(feed.files) && feed.files.length >= 1, `${feed.name} has no files`);
		}
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
		if (feed.source === 'api') {
			// An API feed has no files on purpose (the seed pulls from the
			// vendor API), so there are no specs to validate.
			assert.deepStrictEqual(feed.fileSpecs, [], `${feed.name}: an API feed cannot have fileSpecs`);
			continue;
		}
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

test('jrp-ftp is a pulled feed of one file whose signature is the JRP layout', () => {
	const { EXPECTED_COLUMNS } = require('../../config/jrp');
	const jrp = feedsConfig.getFeedByName('jrp-ftp');
	assert.deepStrictEqual(jrp.files, ['JUSJEE.csv']);
	assert.deepStrictEqual(feedsConfig.getFileSpec(jrp, 'JUSJEE.csv').signature, [...EXPECTED_COLUMNS]);
	assert.strictEqual(jrp.fetch, 'ftp');
	assert.strictEqual(jrp.fetchCommand, 'feed-fetch-jrp');
	assert.strictEqual(jrp.recordsOwnRuns, true);
	assert.strictEqual(jrp.legacyDir, 'jrp_files');
	assert.strictEqual(jrp.staleAfterHours, 36);
});

test('jrp-ftp is applied by seed-jrp and its scheduled apply holds the Run now gate', () => {
	const jrp = feedsConfig.getFeedByName('jrp-ftp');
	assert.strictEqual(jrp.seedCommand, 'seed-jrp');
	assert.deepStrictEqual(jrp.syncCommands, ['seed-jrp']);
	assert.strictEqual(jrp.applyCommand, 'feed-apply-jrp');
});

test('cad-store-prices publishes the weekly CSV to the live store, behind a warning', () => {
	const cad = feedsConfig.getFeedByName('cad-store-prices');
	assert.deepStrictEqual(cad.files, ['cad-store-price-update.csv']);
	assert.deepStrictEqual(
		feedsConfig.getFileSpec(cad, 'cad-store-price-update.csv').signature,
		['sku', 'price', 'black_friday_sale', 'store_view_code']
	);
	assert.strictEqual(cad.seedCommand[0], 'update-cad-csv-all-live');
	// seed-allProducts runs right after the publish, so the Product table (and
	// the search page) reflects the prices and sale tiers that just went live.
	assert.deepStrictEqual(cad.seedCommand, ['update-cad-csv-all-live', 'seed-allProducts']);
	assert.strictEqual(cad.legacyDir, 'cad_store_files');
	// It writes to the LIVE store: the panel must show the warning first, and
	// the run needs more room than the default 30 minutes.
	assert.ok(cad.runWarning && /LIVE store/.test(cad.runWarning));
	assert.strictEqual(cad.runTimeoutMs, 6 * 60 * 60 * 1000);
	assert.strictEqual(cad.staleAfterHours, 14 * 24);
});

test('only live-store publishers carry a runWarning', () => {
	for (const feed of feedsConfig.getFeedDefinitions()) {
		if (feed.name === 'cad-store-prices') continue;
		assert.strictEqual(feed.runWarning, null, `${feed.name} should not have a runWarning`);
	}
});

test('magento-products is API-sourced: no files, run by seed-allProducts', () => {
	const magento = feedsConfig.getFeedByName('magento-products');
	assert.strictEqual(magento.source, 'api');
	assert.deepStrictEqual(magento.files, []);
	assert.deepStrictEqual(magento.fileSpecs, []);
	assert.strictEqual(magento.fetch, undefined, 'nothing is pulled into the bucket: the seed talks to the Magento API');
	assert.strictEqual(magento.seedCommand, 'seed-allProducts');
	assert.deepStrictEqual(magento.syncCommands, ['seed-allProducts']);
	assert.strictEqual(magento.recordsOwnRuns, false);
});

test('every file feed defaults to source "file"', () => {
	for (const feed of feedsConfig.getFeedDefinitions()) {
		if (feed.name === 'magento-products') continue;
		assert.strictEqual(feed.source, 'file', `${feed.name} should be a file feed`);
	}
});

test('grandwest is a manual upload feed of one CSV, applied by seed-grandwest', () => {
	const { EXPECTED_COLUMNS, FEED_ID, FILE_NAME } = require('../../config/grandwest');
	const grandwest = feedsConfig.getFeedByName(FEED_ID);
	assert.deepStrictEqual(grandwest.files, [FILE_NAME]);
	assert.deepStrictEqual(feedsConfig.getFileSpec(grandwest, FILE_NAME).signature, [...EXPECTED_COLUMNS]);
	assert.strictEqual(grandwest.fetch, undefined, 'nothing is pulled: the file is uploaded in the panel');
	assert.strictEqual(grandwest.seedCommand, 'seed-grandwest');
	assert.deepStrictEqual(grandwest.syncCommands, ['seed-grandwest']);
	assert.strictEqual(grandwest.recordsOwnRuns, true);
	assert.strictEqual(grandwest.staleAfterHours, 14 * 24);
});

test('the CAD store publish lets the orders sync run alongside it, and nothing else', () => {
	const cad = feedsConfig.getFeedByName('cad-store-prices');
	assert.deepStrictEqual(cad.cronsAllowedDuringRun, ['seed-orders-delta', 'seed-orders']);
});
