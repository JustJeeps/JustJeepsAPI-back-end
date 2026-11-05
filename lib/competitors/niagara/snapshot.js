// Niagara Jeeps snapshot files (DD-021): one per run, named so a real, dry,
// sample or collect-only run is obvious at a glance, and the check that a file
// passed to --from-snapshot really is a Niagara payload v1 before it is
// ingested with the same checks a live collect passes. Pure.

const { SCHEMA_VERSION } = require('./collect');
const { checkCollection } = require('./canaries');

function snapshotFileName({ runId, dryRun = false, sample = false, stamp }) {
	if (runId === null || runId === undefined) return `niagara-collect-${stamp}.json`;
	return `niagara-run-${runId}${dryRun ? '-dry-run' : ''}${sample ? '-sample' : ''}-${stamp}.json`;
}

const bad = (message) => {
	const error = new Error(`NIAGARA_BAD_SNAPSHOT: ${message}`);
	error.code = 'NIAGARA_BAD_SNAPSHOT';
	return error;
};

const HOUR_MS = 60 * 60 * 1000;
const canonicalSku = (sku) => sku.trim().toUpperCase();

function validItem(item, maxPrice) {
	return item && typeof item.jjPrefix === 'string' && item.jjPrefix
		&& typeof item.competitorSku === 'string' && item.competitorSku
		&& item.competitorSku === canonicalSku(item.competitorSku)
		&& Number.isFinite(item.price) && item.price > 0 && item.price <= maxPrice
		&& typeof item.url === 'string' && item.url.startsWith('https://');
}

function checkAge(payload, { now, maxAgeHours }) {
	const captured = Date.parse(payload.capturedAt);
	if (!Number.isFinite(captured)) throw bad('no valid capturedAt');
	const ageMs = now().getTime() - captured;
	if (ageMs < 0) throw bad(`capturedAt ${payload.capturedAt} is in the future`);
	if (ageMs > maxAgeHours * HOUR_MS) throw bad(`captured ${payload.capturedAt}, older than ${maxAgeHours} hours: its prices would overwrite newer ones`);
}

function checkItems(items, maxPrice) {
	const seen = new Set();
	items.forEach((item, i) => {
		if (!validItem(item, maxPrice)) throw bad(`item ${i} has no usable brand, sku, price (up to ${maxPrice}) or link, or a sku the collector never writes`);
		const key = `${item.jjPrefix} ${item.competitorSku}`;
		if (seen.has(key)) throw bad(`duplicate ${key}`);
		seen.add(key);
	});
}

// A replay overwrites live prices and a full one becomes the match baseline,
// so it must pass what a live collect would have: freshness, the price cap,
// the collector's sku spelling, no duplicates and the collection guards.
function validateSnapshot(payload, { now, maxAgeHours, maxPrice, thresholds }) {
	if (!payload || payload.source !== 'niagara') throw bad('not a Niagara Jeeps payload');
	if (payload.schemaVersion !== SCHEMA_VERSION) throw bad(`schemaVersion ${payload.schemaVersion}, expected ${SCHEMA_VERSION}`);
	if (!Array.isArray(payload.items)) throw bad('no items array');
	checkAge(payload, { now, maxAgeHours });
	checkItems(payload.items, maxPrice);
	if (!payload.collection) throw bad('no collection stats');
	const verdict = checkCollection(payload.collection, thresholds, { sample: Boolean(payload.sample) });
	if (!verdict.ok) throw bad(verdict.failures.map((f) => `${f.code}: ${f.message}`).join('; '));
	return payload;
}

module.exports = { snapshotFileName, validateSnapshot };
