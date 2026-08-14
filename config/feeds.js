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

const FEED_DEFINITIONS = [
	{
		name: 'keystone-ftp',
		label: 'Keystone (FTP)',
		files: ['Inventory.csv', 'SpecialOrder.csv'],
		seedCommand: 'seed-keystone-ftp2',
		syncCommands: ['seed-keystone-ftp2', 'seed-keystone-ftp-codes'],
		recordsOwnRuns: true,
		legacyDir: 'keystone_files',
		staleAfterHours: 36, // fetch runs 2x/day; 36h = missed 2 fetches
		fetch: 'ftp',
		// Manual trigger for the scheduled fetch (4:47 and 16:47). The schedule is
		// a guess about when the vendor publishes, and when it guesses wrong the
		// run succeeds with yesterday's file and there is nothing to do until the
		// next window.
		fetchCommand: 'feed-fetch-keystone',
		maxUploadBytes: 600 * 1024 * 1024, // SpecialOrder.csv chega a 460MB (upload assinado direto ao bucket)
	},
	{
		// One vendor, two files: the wholesale CSV carries inventory and the
		// pricing sheet carries prices, and the scripts read them together (the
		// price seed hashes both plus the CAD rate, so replacing only one would
		// freeze the other). Keeping them as a single feed also means the batch
		// is only current when both files are present.
		name: 'quadratec',
		label: 'Quadratec (CSV + XLSX)',
		files: ['quadratec_wholesale.csv', 'pricingSheet_quad.xlsx'],
		seedCommand: ['seed-quadratec', 'seed-quad-inventory'],
		syncCommands: ['seed-quadratec', 'seed-quad-inventory'],
		recordsOwnRuns: true,
		workbookBaseNames: ['quadratec_wholesale', 'pricingSheet_quad'],
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'ctp',
		label: 'CTP inventory (CSV)',
		files: ['CTPENT_Inventory.csv'],
		seedCommand: 'seed-ctp',
		syncCommands: ['seed-ctp'],
		recordsOwnRuns: true,
		workbookBaseName: 'CTPENT_Inventory',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'keyparts',
		label: 'KeyParts price file (XLSX)',
		files: ['KeyParts-price-file.xlsx'],
		seedCommand: 'seed-keyparts',
		syncCommands: ['seed-keyparts'],
		recordsOwnRuns: true,
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'warn-map',
		label: 'WARN MAP prices (XLSX)',
		files: ['WARN-MAP.xlsx'],
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
		files: ['accessoriesInvPriceData.csv', 'tireInvPriceData.csv', 'wheelInvPriceData.csv'],
		seedCommand: 'seed-wp-inventory',
		syncCommands: ['seed-wheelPros', 'seed-wp-inventory'],
		recordsOwnRuns: true,
		staleAfterHours: 30 * DAY_HOURS,
		maxUploadBytes: 600 * 1024 * 1024, // os CSVs chegam a ~500MB (upload assinado direto ao bucket)
	},
	{
		name: 'omix',
		label: 'Omix price sheet (XLSX)',
		files: ['omix-excel.xlsx'],
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
		files: ['customers_qb_desktop.csv', 'transactions_per_customer.csv'],
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
		files: ['AEV-price-file.xlsx'],
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
	getFeedByWorkbookBaseName,
	config: {
		uploadPanelMaxBytes,
	},
};
