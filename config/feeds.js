// Central registry of the vendor feeds stored in DO Spaces (landing zone).
// Each feed lists the CANONICAL files the seeds expect, and the materializer
// delivers exactly those names in a local cache directory.
//
// IMPORTANT: this module has to stay "pure", only process.env and literal
// data (same rule as config/cron-jobs.js), so it can be loaded by tests and
// validation scripts without booting the server.
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
// seedCommand: npm script that consumes the feed, triggerable by the panel's
// "Run now" button (POST /api/ingest/feeds/:feed/run) to check the file that
// was just uploaded without waiting for seed-all. null = no button; use
// seedCommandNote to explain why (e.g. a script that writes prices to the
// live store, which should only run through the controlled seed-all flow).

const DAY_HOURS = 24;

const FEED_DEFINITIONS = [
	{
		name: 'keystone-ftp',
		label: 'Keystone (FTP)',
		files: ['Inventory.csv', 'SpecialOrder.csv'],
		seedCommand: 'seed-keystone-ftp2',
		legacyDir: 'keystone_files',
		staleAfterHours: 36, // fetch runs 2x/day; 36h = missed 2 fetches
		fetch: 'ftp',
		maxUploadBytes: 600 * 1024 * 1024, // CLI only in practice (the panel caps at uploadPanelMaxBytes)
	},
	{
		name: 'quadratec-wholesale',
		label: 'Quadratec wholesale (CSV)',
		files: ['quadratec_wholesale.csv'],
		seedCommand: 'seed-quad-inventory',
		workbookBaseName: 'quadratec_wholesale',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'quadratec-pricing',
		label: 'Quadratec pricing sheet (XLSX)',
		files: ['pricingSheet_quad.xlsx'],
		seedCommand: 'seed-quadratec',
		staleAfterHours: 60 * DAY_HOURS,
	},
	{
		name: 'ctp',
		label: 'CTP inventory (CSV)',
		files: ['CTPENT_Inventory.csv'],
		seedCommand: 'seed-ctp',
		workbookBaseName: 'CTPENT_Inventory',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'keyparts',
		label: 'KeyParts price file (XLSX)',
		files: ['KeyParts-price-file.xlsx'],
		seedCommand: 'seed-keyparts',
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'warn-map',
		label: 'WARN MAP prices (XLSX)',
		files: ['WARN-MAP.xlsx'],
		seedCommand: null,
		seedCommandNote: 'Updates prices on the live store, so it only runs in the daily sync',
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'wheelpros-inventory',
		label: 'WheelPros inventory (3 CSVs)',
		files: ['accessoriesInvPriceData.csv', 'tireInvPriceData.csv', 'wheelInvPriceData.csv'],
		seedCommand: 'seed-wp-inventory',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'omix',
		label: 'Omix price sheet (XLSX)',
		files: ['omix-excel.xlsx'],
		seedCommand: 'seed-omix',
		staleAfterHours: 120 * DAY_HOURS,
	},
	{
		name: 'aev',
		label: 'AEV price file (XLSX)',
		files: ['AEV-price-file.xlsx'],
		seedCommand: 'seed-aev',
		staleAfterHours: 365 * DAY_HOURS,
	},
];

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// The upload panel/API never accepts more than this, whatever the feed:
// SpecialOrder-class files (460MB) come in by FTP fetch or CLI.
const uploadPanelMaxBytes = Number(process.env.FEED_UPLOAD_PANEL_MAX_BYTES || DEFAULT_MAX_UPLOAD_BYTES);

const envStaleKey = (name) => `FEED_STALE_HOURS_${name.toUpperCase().replace(/-/g, '_')}`;

function getFeedDefinitions() {
	return FEED_DEFINITIONS.map((feed) => {
		const override = Number(process.env[envStaleKey(feed.name)]);
		return {
			...feed,
			legacyDir: feed.legacyDir || '',
			seedCommand: feed.seedCommand || null,
			seedCommandNote: feed.seedCommandNote || null,
			staleAfterHours: Number.isFinite(override) && override > 0 ? override : feed.staleAfterHours,
			maxUploadBytes: Math.min(feed.maxUploadBytes || DEFAULT_MAX_UPLOAD_BYTES, uploadPanelMaxBytes),
		};
	});
}

function getFeedByName(name) {
	return getFeedDefinitions().find((feed) => feed.name === name) || null;
}

// Bridge to the central workbook resolver (load-workbook.js): file baseName
// -> matching feed.
function getFeedByWorkbookBaseName(baseName) {
	return getFeedDefinitions().find((feed) => feed.workbookBaseName === baseName) || null;
}

module.exports = {
	getFeedDefinitions,
	getFeedByName,
	getFeedByWorkbookBaseName,
	config: {
		uploadPanelMaxBytes,
	},
};
