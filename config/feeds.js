// Central registry of the vendor feeds stored in DO Spaces (landing zone).
// Each feed lists the CANONICAL files the seeds expect, and the materializer
// delivers exactly those names in a local cache directory.
//
// IMPORTANT: this module has to stay "pure", only process.env and literal
// data (same rule as config/cron-jobs.js), so it can be loaded by tests and
// validation scripts without booting the server.
//
// fileSpecs: one entry per canonical file, { name, label, signature, sheet }.
//   - name: the canonical file name, the key everywhere else (catalog,
//     materializer, legacy symlinks, retention, seeds). `files` is derived
//     from it, so nothing downstream changes.
//   - label: what the panel shows next to a detected file ("Quadratec gold
//     kit"), plain words.
//   - signature: the exact, ordered list of header columns, taken from the
//     real vendor file (lib/feeds/fileSignature.js normalizes: trimmed, inner
//     whitespace collapsed, leading/trailing empty cells dropped, empty cells
//     in the middle kept). A file is identified by this signature, never by
//     the name it arrived with: people drop "gold kit 10.13.26.xlsx" and the
//     panel/CLI/API work out which canonical file it is. Order matters because
//     several seeds read columns by position. When a vendor changes its
//     columns, update the signature here (docs/FEEDS.md explains how).
//   - sheet: the sheet the seed reads (KeyParts "Price List"), null = first.
//
// staleAfterHours: batch age from which the feed shows up as stale (warning
// in the digest/panel; ingest only fails with requireFresh). Manual drop
// feeds change when the vendor sends a new spreadsheet, so the thresholds are
// generous. Env override: FEED_STALE_HOURS_<NAME_UPPER_SNAKE> (e.g.
// FEED_STALE_HOURS_KEYSTONE_FTP=48).
//
// maxUploadBytes caps the upload through the panel/API (bigger files, the
// SpecialOrder.csv case, arrive by FTP fetch or CLI, never by the panel).
//
// legacyDir: subdirectory of prisma/seeds/api-calls where feed-sync creates
// the symlink with the canonical name, so the seeds keep reading the usual
// path and the file behind it comes from the bucket ('' = api-calls root).
//
// ingestFeed: name the consuming seed uses when it records an IngestRun. It is
// usually the feed name, but not always: seed-quadratec records both Quadratec
// files under "quadratec". Without this mapping the panel looked for runs under
// the registry name, found none, and showed "never" next to a feed that had
// just been ingested.
//
// syncCommands: every npm script the daily sync runs for this feed, including
// the ones that have no button. seedCommand doubles as the Run now allowlist,
// so without this list a feed like warn-map (hidden button on purpose) was
// processed every night and still showed "never" on screen.
//
// recordsOwnRuns: the script records its own IngestRun with real row counts, so
// bookkeeping must not add a zero-count row on top of it.
//
// fetchCommand: npm script that goes and gets the file at the vendor, exposed as
// a "Fetch now" button. Only for feeds that are pulled (fetch: 'ftp').
//
// restricted: the feed carries personal or financial data, so it is hidden from
// the panel and the run history for anyone outside the triage list. Uploading
// and running were already triage only; this closes the metadata as well.
//
// seedCommand: npm script that consumes the feed, triggerable by the panel's
// "Run now" button (POST /api/ingest/feeds/:feed/run) to check the file that
// was just uploaded without waiting for seed-all. null = no button; use
// seedCommandNote to explain why (e.g. a script that writes prices to the
// live store, which should only run through the controlled seed-all flow).

const DAY_HOURS = 24;

const { EXPECTED_COLUMNS: JRP_COLUMNS, FEED_ID: JRP_FEED_ID, REMOTE_FILE: JRP_REMOTE_FILE } = require('./jrp');

// Keystone publishes Inventory.csv and SpecialOrder.csv with the same layout
// (verified against the bucket copies of 2026-10-14). The signature alone
// cannot tell them apart; the name the file arrived with breaks the tie.
const KEYSTONE_FTP_COLUMNS = [
	'VendorName', 'VCPN', 'VendorCode', 'PartNumber', 'ManufacturerPartNo', 'LongDescription', 'JobberPrice', 'Cost',
	'Purolatorable', 'CoreCharge', 'CaseQty', 'IsNonReturnable', 'Prop65Toxicity', 'UPCCode', 'Weight', 'Height',
	'Length', 'Width', 'AAIACode', 'IsHazmat', 'IsChemical', 'Puralator_Ground_Assessorials', 'EastQty', 'MidwestQty',
	'CaliforniaQty', 'SoutheastQty', 'PacificNWQty', 'TexasQty', 'GreatLakesQty', 'FloridaQty', 'TotalQty',
	'KitComponents', 'IsKit',
];

// The three WheelPros CSVs end with one quantity column per warehouse.
const WHEELPROS_STORE_COLUMNS = ['1011', '1015', '1019', '1022', '1028', '1031', '1036', '1072', '1085', '1086', '1088', '4033', '4035'];

const FEED_DEFINITIONS = [
	{
		name: 'keystone-ftp',
		label: 'Keystone (FTP)',
		fileSpecs: [
			{
				name: 'Inventory.csv',
				label: 'Keystone inventory',
				signature: KEYSTONE_FTP_COLUMNS,
				sheet: null,
			},
			{
				name: 'SpecialOrder.csv',
				label: 'Keystone special order',
				signature: KEYSTONE_FTP_COLUMNS,
				sheet: null,
			},
		],
		seedCommand: 'seed-keystone-ftp2',
		syncCommands: ['seed-keystone-ftp2', 'seed-keystone-ftp-codes'],
		// Scheduled job (10:10) that runs the sync above on its own; Run now
		// refuses while it holds the cron gate.
		applyCommand: 'feed-apply-keystone',
		recordsOwnRuns: true,
		legacyDir: 'keystone_files',
		// Fetch at 9:30 with a 12:47 catch-up, so a batch is ~15h old at the
		// 00:10 digest and 36h is exactly "the last fetches brought nothing new".
		// It was calibrated for two fetches a day and left untouched when the
		// schedule became one (2026-09-16), which is why a single day-old
		// SpecialOrder.csv was enough to trip it.
		staleAfterHours: 36,
		fetch: 'ftp',
		// Manual trigger for the scheduled fetch (9:30, catch-up 12:47). The schedule sits after
		// the vendor's measured publishing window, but the window does move, and
		// when it moves past us the run succeeds with yesterday's file and there
		// is nothing to do until the next window.
		fetchCommand: 'feed-fetch-keystone',
		maxUploadBytes: 600 * 1024 * 1024, // SpecialOrder.csv chega a 460MB (upload assinado direto ao bucket)
	},
	{
		// JRP publishes one CSV (JUSJEE.csv) on its FTPS server every morning
		// (seen written 08:42 ET) and overwrites it in place. Pulled by
		// feed-fetch-jrp, applied by seed-jrp (config/jrp.js has the constants).
		name: JRP_FEED_ID,
		label: 'JRP (FTP)',
		fileSpecs: [
			{
				name: JRP_REMOTE_FILE,
				label: 'JRP inventory and prices',
				signature: [...JRP_COLUMNS],
				sheet: null,
			},
		],
		// seedCommand 'seed-jrp' is added together with its npm script: the
		// cron verification (npm test) refuses a seedCommand that package.json
		// does not define yet.
		recordsOwnRuns: true,
		legacyDir: 'jrp_files',
		// One fetch a day, so 36h means the last fetch brought nothing new
		// (same reasoning as keystone-ftp).
		staleAfterHours: 36,
		fetch: 'ftp',
		fetchCommand: 'feed-fetch-jrp',
	},
	{
		// One vendor, three files: the wholesale CSV carries inventory, the gold
		// sheet carries item prices and the gold kit carries kit prices. The
		// scripts read them together (the price seed hashes the sheet and the kit
		// plus the CAD rate, so replacing only one would freeze the others).
		// Keeping them as a single feed also means the batch is only current
		// when every file is present.
		//
		// The kit file is REQUIRED on purpose. Up to Sep 2026 the kits were rows
		// inside the gold sheet; in Oct 2026 Quadratec moved them to a separate
		// "gold kit" export. seed-quadratec deletes the VendorProduct rows that
		// are missing from the files (staleStrategy delete), so a batch with the
		// sheet alone would remove the ~6k kit rows. Making the kit optional
		// would let that happen silently; requiring it makes the batch wait.
		name: 'quadratec',
		label: 'Quadratec (CSV + gold sheet + gold kit)',
		fileSpecs: [
			{
				name: 'quadratec_wholesale.csv',
				label: 'Quadratec wholesale CSV (inventory)',
				signature: ['Quadratec Part No', 'Part No', 'Description', 'Brand', 'Inventory PA1', 'Inventory PA2', 'Inventory NV1', 'Inventory Total', 'Cost', 'Surcharge', 'UPC', 'MAP'],
				sheet: null,
			},
			{
				name: 'pricingSheet_quad.xlsx',
				label: 'Quadratec gold sheet',
				signature: ['Quadratec PN', 'MPN', 'Description', 'UPC Code', 'Brand', 'Retail Price', 'Wholesale Price', 'Shipping Surcharge'],
				sheet: null,
			},
			{
				name: 'pricingKit_quad.xlsx',
				label: 'Quadratec gold kit',
				signature: ['Name', 'Display Name', 'Retail Price', 'Wholesale Price', 'Brand'],
				sheet: null,
			},
		],
		seedCommand: ['seed-quadratec', 'seed-quad-inventory'],
		syncCommands: ['seed-quadratec', 'seed-quad-inventory'],
		recordsOwnRuns: true,
		workbookBaseNames: ['quadratec_wholesale', 'pricingSheet_quad', 'pricingKit_quad'],
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'ctp',
		label: 'CTP inventory (CSV)',
		fileSpecs: [
			{
				name: 'CTPENT_Inventory.csv',
				label: 'CTP inventory',
				signature: ['StockCode', 'SupplierCode', 'Description', 'BrandName', 'AAIA', 'Barcode', 'QtyAvailable', 'ListPrice', 'JobberPrice', 'CustPrice', 'MAP', 'SpecialOrder', 'NonReturnable', 'Oversize', 'LiftGateReq'],
				sheet: null,
			},
		],
		seedCommand: 'seed-ctp',
		syncCommands: ['seed-ctp'],
		recordsOwnRuns: true,
		workbookBaseName: 'CTPENT_Inventory',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'keyparts',
		label: 'KeyParts price file (XLSX)',
		fileSpecs: [
			{
				name: 'KeyParts-price-file.xlsx',
				label: 'KeyParts price list',
				signature: ['Item', 'Description', 'Unit Price'],
				sheet: 'Price List',
			},
		],
		seedCommand: 'seed-keyparts',
		syncCommands: ['seed-keyparts'],
		recordsOwnRuns: true,
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'warn-map',
		label: 'WARN MAP prices (XLSX)',
		fileSpecs: [
			{
				name: 'WARN-MAP.xlsx',
				label: 'WARN MAP prices',
				signature: ['Product Category', '', 'WARN Part Number', 'Product Description', '', 'Retailer to Consumer', 'MSRP/CAN'],
				sheet: 'Table 1',
			},
		],
		// No button on purpose: this script publishes prices to the live store.
		// It still runs in the daily sync, so bookkeeping follows it here.
		seedCommand: null,
		seedCommandNote: 'Updates prices on the live store, so it only runs in the daily sync',
		syncCommands: ['update-warn-cad-map-prices'],
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'wheelpros-inventory',
		label: 'WheelPros inventory (3 CSVs)',
		fileSpecs: [
			{
				name: 'accessoriesInvPriceData.csv',
				label: 'WheelPros accessories inventory',
				signature: ['PartNumber', 'PartDescription', 'Brand', 'CapHardwareDescription', 'CapScrewQuantity', 'CapWrench', 'CapStyleDescription', 'ImageURL', 'TotalQOH', 'MSRP_CAD', 'MAP_CAD', 'RunDate', ...WHEELPROS_STORE_COLUMNS],
				sheet: null,
			},
			{
				name: 'tireInvPriceData.csv',
				label: 'WheelPros tire inventory',
				signature: ['Brand', 'PartNumber', 'PartDescription', 'ManufacturerPartNumber', 'ImageURL', 'InvOrderType', 'TotalQOH', 'MSRP_CAD', 'MAP_CAD', 'RunDate', 'Division', ...WHEELPROS_STORE_COLUMNS],
				sheet: null,
			},
			{
				name: 'wheelInvPriceData.csv',
				label: 'WheelPros wheel inventory',
				signature: ['PartNumber', 'PartDescription', 'Brand', 'DisplayStyleNo', 'Finish', 'Size', 'BoltPattern', 'Offset', 'CenterBore', 'LoadRating', 'ShippingWeight', 'ImageURL', 'InvOrderType', 'Style', 'TotalQOH', 'MSRP_CAD', 'MAP_CAD', 'RunDate', ...WHEELPROS_STORE_COLUMNS],
				sheet: null,
			},
		],
		seedCommand: 'seed-wp-inventory',
		syncCommands: ['seed-wheelPros', 'seed-wp-inventory'],
		recordsOwnRuns: true,
		staleAfterHours: 30 * DAY_HOURS,
		maxUploadBytes: 600 * 1024 * 1024, // os CSVs chegam a ~500MB (upload assinado direto ao bucket)
	},
	{
		name: 'omix',
		label: 'Omix price sheet (XLSX)',
		fileSpecs: [
			{
				name: 'omix-excel.xlsx',
				label: 'Omix price sheet',
				signature: ['Account#', 'Desc', 'Brand', 'PF Desc', 'Product Class', 'Product Line', 'Prefix', 'Part Number', 'Jobber', 'Quoted Price', 'Cust Item', 'MAP', 'MSRP', 'UPC', 'Mfg Co', 'Origin', 'Sch B'],
				sheet: null,
			},
		],
		seedCommand: 'seed-omix',
		syncCommands: ['seed-omix', 'seed-omix-inventory'],
		recordsOwnRuns: true,
		// The vendor genuinely revises this sheet about twice a year (confirmed
		// by Ricardo, 2026-08-08), so anything under six months is the normal
		// rhythm and alerting sooner would just train people to ignore it. The
		// age is always on screen either way: this threshold decides when it
		// becomes a complaint, not whether the date is shown.
		staleAfterHours: 180 * DAY_HOURS,
	},
	{
		// Not a vendor price file: the two manual exports from QuickBooks Desktop
		// that feed the customer lookup used for fraud triage. It lives here for
		// one reason: refreshing it used to mean scp to the droplet plus a
		// docker exec inside the container, so it was refreshed exactly once and
		// then went stale for weeks. Through the panel it is two files dragged
		// into the browser.
		//
		// legacyDir is absolute in production (the inbox volume the lookup reads,
		// QB_LOOKUP_DATA_DIR=/data/quickbooks-customers), which is why legacySync
		// resolves instead of joining. Without the env it lands in a folder under
		// api-calls, which is harmless and inspectable in development.
		name: 'quickbooks',
		label: 'QuickBooks customer export (2 CSVs)',
		fileSpecs: [
			{
				name: 'customers_qb_desktop.csv',
				label: 'QuickBooks customers export',
				signature: ['Customer', '', 'Invoice to', '', 'Main Email', '', 'First Name', '', 'Last Name', '', 'Main Phone', '', 'Balance Total', '', 'Street1', '', 'Street2', '', 'City', '', 'Province', '', 'Postal Code', '', 'Country'],
				sheet: null,
			},
			{
				name: 'transactions_per_customer.csv',
				label: 'QuickBooks transactions per customer',
				signature: ['Type', '', 'Date', '', 'Num', '', 'Name', '', 'Memo', '', 'Account', '', 'Clr', '', 'Split', '', 'Debit', '', 'Credit'],
				sheet: null,
			},
		],
		seedCommand: 'seed-quickbooks-customers',
		syncCommands: ['seed-quickbooks-customers'],
		// Read per call (legacyDirEnv), like the staleness overrides: a value
		// frozen at require time cannot be exercised by a test and drifts from
		// whatever the container is actually configured with.
		legacyDir: 'quickbooks',
		legacyDirEnv: 'QB_LOOKUP_DATA_DIR',
		restricted: true,
		// Same threshold the freshness cron warns at (QB_STALE_WARN_DAYS=14), so
		// the panel and the daily e-mail never disagree about what counts as old.
		staleAfterHours: 14 * DAY_HOURS,
	},
	{
		name: 'aev',
		label: 'AEV price file (XLSX)',
		fileSpecs: [
			{
				name: 'AEV-price-file.xlsx',
				label: 'AEV price file',
				signature: ['Manufacturer SKU', 'UPC #', 'REV LEVEL UPDATED', 'Discontinued', 'Product Title', 'Product Summary', 'Brand', 'Country of Origin', 'Jobber Price', 'Dealer Price', 'Dealer+ Price', 'MAP Pricing', 'eCommerce', 'Fitment Summary', 'Description', 'Key Features', 'Tech Specs', 'Important Notes', 'Installation Difficulty', 'Length (in)', 'Width (in)', 'Height (in)', 'Weight (lb)', 'Number of Boxes', 'Ships Freight?', 'Image', 'Image', 'Image', 'Image', 'Image', 'PDF (Installation Instructions)', 'Link to Product Page', 'American Expedition Vehicles SKU', 'Years', 'Make', 'Model', 'Sub-Model', 'Engine', 'CAB', 'Notes', 'Product Title', 'American Expedition Vehicles SKU', 'Category'],
				sheet: 'All SKUs',
			},
		],
		seedCommand: 'seed-aev',
		syncCommands: ['seed-aev'],
		staleAfterHours: 365 * DAY_HOURS,
	},
];

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Ceiling for the LEGACY upload through the API only (multer buffers the file
// on the container disk — 1 vCPU / 2GB). The signed multipart upload goes
// straight from the browser to the bucket and is bounded by each feed's own
// maxUploadBytes instead; clamping feeds to this value was what blocked the
// 500MB WheelPros CSVs in the panel (fixed 2026-08-14).
const uploadPanelMaxBytes = Number(process.env.FEED_UPLOAD_PANEL_MAX_BYTES || DEFAULT_MAX_UPLOAD_BYTES);

const envStaleKey = (name) => `FEED_STALE_HOURS_${name.toUpperCase().replace(/-/g, '_')}`;

function getFeedDefinitions() {
	return FEED_DEFINITIONS.map((feed) => {
		const override = Number(process.env[envStaleKey(feed.name)]);
		return {
			...feed,
			// Canonical names, derived from the specs: everything downstream keys
			// on them and never looks at the signatures.
			files: feed.fileSpecs.map((spec) => spec.name),
			legacyDir: (feed.legacyDirEnv ? process.env[feed.legacyDirEnv] : '') || feed.legacyDir || '',
			ingestFeed: feed.ingestFeed || feed.name,
			seedCommand: feed.seedCommand || null,
			syncCommands: feed.syncCommands || (feed.seedCommand ? [].concat(feed.seedCommand) : []),
			recordsOwnRuns: Boolean(feed.recordsOwnRuns),
			fetchCommand: feed.fetchCommand || null,
			restricted: Boolean(feed.restricted),
			seedCommandNote: feed.seedCommandNote || null,
			staleAfterHours: Number.isFinite(override) && override > 0 ? override : feed.staleAfterHours,
			// Limite PROPRIO do feed (caminho assinado + validacao do painel). O
			// teto do painel NAO clampa aqui — ele vale so para o multer do
			// caminho legado via API (routes/ingest.js).
			maxUploadBytes: feed.maxUploadBytes || DEFAULT_MAX_UPLOAD_BYTES,
		};
	});
}

function getFeedByName(name) {
	return getFeedDefinitions().find((feed) => feed.name === name) || null;
}

// The spec of one canonical file of a feed (feed: name or definition), or
// null. What the signature check reads to know which columns to expect.
function getFileSpec(feed, fileName) {
	const definition = typeof feed === 'string' ? getFeedByName(feed) : feed;
	return definition?.fileSpecs?.find((spec) => spec.name === fileName) || null;
}

// Every spec of every feed, each tagged with its feed name: the candidate
// list for classifying a file nobody has named yet.
function getAllFileSpecs() {
	return getFeedDefinitions().flatMap((feed) => feed.fileSpecs.map((spec) => ({ feed: feed.name, fileName: spec.name, label: spec.label, signature: spec.signature, sheet: spec.sheet })));
}

// Bridge to the central workbook resolver (load-workbook.js): file baseName
// -> matching feed.
// A feed may answer for more than one workbook, which is the case for vendors
// that ship a CSV and a spreadsheet that are read together.
function getFeedByWorkbookBaseName(baseName) {
	return getFeedDefinitions().find((feed) =>
		feed.workbookBaseName === baseName || (feed.workbookBaseNames || []).includes(baseName)
	) || null;
}

module.exports = {
	getFeedDefinitions,
	getFeedByName,
	getFileSpec,
	getAllFileSpecs,
	getFeedByWorkbookBaseName,
	config: {
		uploadPanelMaxBytes,
	},
};
