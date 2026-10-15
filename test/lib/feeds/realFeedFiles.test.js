const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Every REAL vendor file that sits at its legacy path has to classify to
// exactly its canonical name through the registry signatures, whatever name
// it is given. The files are gitignored data, so a missing one skips instead
// of failing (CI has none of them; a developer machine has most).
//
// When a vendor changes its columns this is the test that goes red once the
// new file is put at its legacy path: update the signature in config/feeds.js.

const { classifyLocalFile, verifyLocalFile } = require('../../../services/feeds/signatureCheck');
const feedsConfig = require('../../../config/feeds');

const API_CALLS = path.join(__dirname, '../../../prisma/seeds/api-calls');

const cases = [
	// Keystone: identical headers, the name breaks the tie.
	{ feed: 'keystone-ftp', fileName: 'Inventory.csv', file: 'keystone_files/Inventory.csv' },
	{ feed: 'keystone-ftp', fileName: 'SpecialOrder.csv', file: 'keystone_files/SpecialOrder.csv' },
	{ feed: 'keystone-ftp', fileName: 'Inventory.csv', file: 'Inventory.csv' },
	{ feed: 'quadratec', fileName: 'quadratec_wholesale.csv', file: 'quadratec_wholesale.csv' },
	// Called the way Quadratec exports it: the name plays no part.
	{ feed: 'quadratec', fileName: 'pricingSheet_quad.xlsx', file: 'pricingSheet_quad.xlsx', originalName: 'gold sheet 10.13.26-1.xlsx' },
	{ feed: 'quadratec', fileName: 'pricingKit_quad.xlsx', file: 'pricingKit_quad.xlsx', originalName: 'gold kit 10.13.26.xlsx' },
	{ feed: 'ctp', fileName: 'CTPENT_Inventory.csv', file: 'CTPENT_Inventory.csv' },
	{ feed: 'wheelpros-inventory', fileName: 'accessoriesInvPriceData.csv', file: 'accessoriesInvPriceData.csv' },
	{ feed: 'wheelpros-inventory', fileName: 'tireInvPriceData.csv', file: 'tireInvPriceData.csv' },
	{ feed: 'wheelpros-inventory', fileName: 'wheelInvPriceData.csv', file: 'wheelInvPriceData.csv' },
	{ feed: 'aev', fileName: 'AEV-price-file.xlsx', file: 'AEV-price-file.xlsx', originalName: 'AEV 2026 pricing.xlsx' },
	{ feed: 'keyparts', fileName: 'KeyParts-price-file.xlsx', file: 'KeyParts-price-file.xlsx', originalName: 'keyparts.xlsx' },
	{ feed: 'warn-map', fileName: 'WARN-MAP.xlsx', file: 'WARN-MAP.xlsx', originalName: 'Warn UMP Canada.xlsx' },
	{ feed: 'omix', fileName: 'omix-excel.xlsx', file: 'omix-excel.xlsx', originalName: 'omix.xlsx' },
	{ feed: 'quickbooks', fileName: 'customers_qb_desktop.csv', file: 'quickbooks/customers_qb_desktop.csv' },
	{ feed: 'quickbooks', fileName: 'transactions_per_customer.csv', file: 'quickbooks/transactions_per_customer.csv' },
];

for (const entry of cases) {
	const filePath = path.join(API_CALLS, entry.file);
	const originalName = entry.originalName || path.basename(entry.file);

	test(`real file ${entry.file} (as "${originalName}") is ${entry.feed}/${entry.fileName}`, (t) => {
		if (!fs.existsSync(filePath)) {
			t.skip(`${entry.file} is not on this machine (gitignored vendor data)`);
			return;
		}
		// Against EVERY feed, not just its own: the file must not look like any
		// other feed's file either.
		const { matches, ambiguous } = classifyLocalFile(filePath, { originalName });
		assert.strictEqual(ambiguous, false, `ambiguous: ${matches.map((m) => `${m.feed}/${m.fileName}`).join(', ')}`);
		assert.deepStrictEqual(matches.map((m) => `${m.feed}/${m.fileName}`), [`${entry.feed}/${entry.fileName}`]);

		const verified = verifyLocalFile(filePath, { feed: entry.feed, fileName: entry.fileName });
		assert.strictEqual(verified.ok, true, verified.message);
	});
}

test('every spec in the registry is covered by a real-file case', () => {
	const covered = new Set(cases.map((entry) => `${entry.feed}/${entry.fileName}`));
	for (const spec of feedsConfig.getAllFileSpecs()) {
		assert.ok(covered.has(`${spec.feed}/${spec.fileName}`), `${spec.feed}/${spec.fileName} has no real-file case`);
	}
});
