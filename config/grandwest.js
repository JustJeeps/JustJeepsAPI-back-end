// Grandwest vendor feed (price list CSV, uploaded by hand in the Feeds panel):
// constants and env helpers for seed-grandwest. Pure: literals at load, env
// only through functions that receive it, same rule as config/jrp.js.

const VENDOR_NAME = 'Grandwest';
const VENDOR_WEBSITE = 'https://www.grandwestauto.com';
const FEED_ID = 'grandwest';
const FILE_NAME = 'grandwest-price-list.csv';

// "Desciption" is Grandwest's spelling; the upload is recognized by this exact list.
const EXPECTED_COLUMNS = Object.freeze(['Item', 'LineCode', 'Desciption', 'UnitPrice', 'ListPrice', 'Quantity', 'UPC']);

const MIN_SIZE_RATIO = 0.7; // a file with fewer than 70% of the last run's rows is suspect
const MAX_INVALID_RATIO = 0.02;
// Provisional floor until the first production dry run shows the real count.
const MIN_MATCHED = 500;

// Per Grandwest line code, how its part number differs from our searchable_sku.
// Checked against our SKUs on 2026-11-10 (see grandwest-linecode-map.csv).
const PLASTICOLOR_DIGITS = 6;
const PART_REWRITES = Object.freeze({
	SMT: (part) => part.replace(/^SB/i, ''), // Smittybilt: SB61468W is our SB-61468W
	DEE: (part) => (/^DZ/i.test(part) ? part : `DZ${part}`), // Dee Zee: we keep the DZ
	PLA: (part) => part.replace(/^\d+/, (digits) => digits.padStart(PLASTICOLOR_DIGITS, '0')), // Plasticolor: zero padded
	FOC: (part) => (/^FOC/i.test(part) ? part : `FOC${part}`), // Focus Auto Design: our FAD-FOC-TG-7W96
});

function partNumberFor(lineCode, part) {
	const rewrite = PART_REWRITES[lineCode];
	if (!rewrite) return part;
	return rewrite(part) || part;
}

// Override for one run if a real file needs it (e.g. GRANDWEST_MAX_INVALID_RATIO=0.05).
function maxInvalidRatio(env = process.env) {
	const n = Number(env.GRANDWEST_MAX_INVALID_RATIO);
	return Number.isFinite(n) && n > 0 && n < 1 ? n : MAX_INVALID_RATIO;
}

function minMatched(env = process.env) {
	const n = Number(env.GRANDWEST_MIN_MATCHED);
	return Number.isInteger(n) && n > 0 ? n : MIN_MATCHED;
}

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

// Grandwest line code -> our jj_prefix, from the rows of vendors_prefix.js that
// carry a grandwest_code. Matching by letters is never safe (CUR is CURT, our
// CUR is Currie), so a code missing here means a brand we do not carry.
function lineCodeToPrefix(vendorsPrefix) {
	const map = new Map();
	for (const row of vendorsPrefix) {
		const code = normalizeCode(row.grandwest_code);
		if (!code) continue;
		if (map.has(code)) {
			throw new Error(`grandwest_code ${code} is set on both ${map.get(code)} and ${row.jj_prefix} in vendors_prefix.js`);
		}
		map.set(code, row.jj_prefix);
	}
	return map;
}

module.exports = {
	VENDOR_NAME,
	VENDOR_WEBSITE,
	FEED_ID,
	FILE_NAME,
	EXPECTED_COLUMNS,
	MIN_SIZE_RATIO,
	MAX_INVALID_RATIO,
	MIN_MATCHED,
	PART_REWRITES,
	partNumberFor,
	maxInvalidRatio,
	minMatched,
	lineCodeToPrefix,
};
