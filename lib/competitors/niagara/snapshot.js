// Niagara Jeeps snapshot files (DD-021): one per run, named so a real, dry,
// sample or collect-only run is obvious at a glance, and the check that a file
// passed to --from-snapshot really is a Niagara payload v1 before it is
// ingested. Pure.

const { SCHEMA_VERSION } = require('./collect');

function snapshotFileName({ runId, dryRun = false, sample = false, stamp }) {
	if (runId === null || runId === undefined) return `niagara-collect-${stamp}.json`;
	return `niagara-run-${runId}${dryRun ? '-dry-run' : ''}${sample ? '-sample' : ''}-${stamp}.json`;
}

const bad = (message) => {
	const error = new Error(`NIAGARA_BAD_SNAPSHOT: ${message}`);
	error.code = 'NIAGARA_BAD_SNAPSHOT';
	return error;
};

function validItem(item) {
	return item && typeof item.jjPrefix === 'string' && item.jjPrefix
		&& typeof item.competitorSku === 'string' && item.competitorSku
		&& Number.isFinite(item.price) && item.price > 0
		&& typeof item.url === 'string' && item.url.startsWith('https://');
}

function validateSnapshot(payload) {
	if (!payload || payload.source !== 'niagara') throw bad('not a Niagara Jeeps payload');
	if (payload.schemaVersion !== SCHEMA_VERSION) throw bad(`schemaVersion ${payload.schemaVersion}, expected ${SCHEMA_VERSION}`);
	if (!Array.isArray(payload.items)) throw bad('no items array');
	const broken = payload.items.findIndex((item) => !validItem(item));
	if (broken !== -1) throw bad(`item ${broken} has no usable brand, sku, price or link`);
	return payload;
}

module.exports = { snapshotFileName, validateSnapshot };
