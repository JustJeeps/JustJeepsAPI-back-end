// Shopify competitor snapshot files (DD-021, DD-022): one per run, named after
// the store so a real, dry, sample or collect-only run is obvious at a glance,
// and the check that a file passed to --from-snapshot really is that store's
// payload v1 before it is ingested with the same checks a live collect passes.
// Pure.

const { SCHEMA_VERSION } = require('./collect');
const { checkCollection } = require('./canaries');

const badSnapshot = (profile) => (message) => {
	const code = profile.code('BAD_SNAPSHOT');
	const error = new Error(`${code}: ${message}`);
	error.code = code;
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

function checkAge(payload, { now, maxAgeHours }, bad) {
	const captured = Date.parse(payload.capturedAt);
	if (!Number.isFinite(captured)) throw bad('no valid capturedAt');
	const ageMs = now().getTime() - captured;
	if (ageMs < 0) throw bad(`capturedAt ${payload.capturedAt} is in the future`);
	if (ageMs > maxAgeHours * HOUR_MS) throw bad(`captured ${payload.capturedAt}, older than ${maxAgeHours} hours: its prices would overwrite newer ones`);
}

function checkItems(items, maxPrice, bad) {
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
function validateStoreSnapshot(profile, payload, { now, maxAgeHours, maxPrice, thresholds }) {
	const bad = badSnapshot(profile);
	if (!payload || payload.source !== profile.key) throw bad(`not a ${profile.competitor.name} payload`);
	if (payload.schemaVersion !== SCHEMA_VERSION) throw bad(`schemaVersion ${payload.schemaVersion}, expected ${SCHEMA_VERSION}`);
	if (!Array.isArray(payload.items)) throw bad('no items array');
	checkAge(payload, { now, maxAgeHours }, bad);
	checkItems(payload.items, maxPrice, bad);
	if (!payload.collection) throw bad('no collection stats');
	const verdict = checkCollection(payload.collection, thresholds, { sample: Boolean(payload.sample) });
	if (!verdict.ok) throw bad(verdict.failures.map((f) => `${f.code}: ${f.message}`).join('; '));
	return payload;
}

function createSnapshot(profile) {
	const snapshotFileName = ({ runId, dryRun = false, sample = false, stamp }) => {
		if (runId === null || runId === undefined) return `${profile.key}-collect-${stamp}.json`;
		return `${profile.key}-run-${runId}${dryRun ? '-dry-run' : ''}${sample ? '-sample' : ''}-${stamp}.json`;
	};
	const validateSnapshot = (payload, options) => validateStoreSnapshot(profile, payload, options);
	return { snapshotFileName, validateSnapshot };
}

module.exports = { createSnapshot };
