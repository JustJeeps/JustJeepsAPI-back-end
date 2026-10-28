// JRP vendor feed (FTPS, daily JUSJEE.csv): constants and env helpers for the
// fetch and apply scripts. Pure: literals at load, env only through functions
// that receive it, same rule as config/tdot.js, so tests can load it freely.

const VENDOR_NAME = 'JRP';
const VENDOR_WEBSITE = 'https://www.jrpdatapoint.com';
const FEED_ID = 'jrp-ftp';
const REMOTE_FILE = 'JUSJEE.csv';

const EXPECTED_COLUMNS = Object.freeze(['BRAND', 'JRPSKU', 'OEMSKU', 'DESCRIPTION', 'IN-STOCK', 'COST', 'MAP']);

const MIN_FILE_BYTES = 500_000;
const MIN_SIZE_RATIO = 0.7; // a new file smaller than 70% of the last one is suspect
const MIN_MATCHED = 1500; // the feed is far larger than our catalog, so gate on matched count
const MAX_INVALID_RATIO = 0.02;
const STOCK_PLUS_VALUE = 4; // IN-STOCK "4+" means at least 4

// Leading text to strip from OEMSKU before matching, keyed by jj_prefix.
// Airaid part numbers embed the brand letters (AIR100-262 is our AIR-100-262).
const OEM_STRIP = Object.freeze({ AIR: /^AIR/ });

// Brands approved on JRP's portal as of 2026-10-27.
const DEFAULT_ACTIVE_BRANDS = Object.freeze(['AFE', 'AIR', 'ALR', 'BIL', 'BOR', 'ESP', 'FLM', 'HOL', 'HU', 'KCH']);

function minMatched(env = process.env) {
	const n = Number(env.JRP_MIN_MATCHED);
	return Number.isInteger(n) && n > 0 ? n : MIN_MATCHED;
}

function activeBrands(env = process.env) {
	const fromEnv = String(env.JRP_ACTIVE_BRANDS || '')
		.split(',')
		.map((entry) => entry.trim().toUpperCase())
		.filter(Boolean);
	return fromEnv.length > 0 ? fromEnv : [...DEFAULT_ACTIVE_BRANDS];
}

function normalizeLabel(label) {
	return String(label || '').trim().toLowerCase();
}

// Map from a normalized JRP BRAND label to our jj_prefix, built from the rows
// of vendors_prefix.js that carry a jrp_code (and optional jrp_aliases).
function brandLabelToPrefix(vendorsPrefix) {
	const pairs = vendorsPrefix
		.filter((row) => normalizeLabel(row.jrp_code))
		.flatMap((row) => [row.jrp_code, ...(row.jrp_aliases || [])]
			.map(normalizeLabel)
			.filter(Boolean)
			.map((label) => [label, row.jj_prefix]));
	return new Map(pairs);
}

module.exports = {
	VENDOR_NAME,
	VENDOR_WEBSITE,
	FEED_ID,
	REMOTE_FILE,
	EXPECTED_COLUMNS,
	MIN_FILE_BYTES,
	MIN_SIZE_RATIO,
	MIN_MATCHED,
	MAX_INVALID_RATIO,
	STOCK_PLUS_VALUE,
	OEM_STRIP,
	DEFAULT_ACTIVE_BRANDS,
	minMatched,
	activeBrands,
	brandLabelToPrefix,
};
