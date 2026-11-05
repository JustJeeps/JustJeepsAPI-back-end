// Suggests how each Niagara Jeeps brand maps to our jj_prefix (DD-021). Only a
// suggestion: the discovery report is reviewed by Ricardo and the approved rows
// are written by hand into vendors_prefix.js (niagara_code, niagara_sku_prefix).
// Pure.

// Words that do not tell two brands apart ("Borla" vs "Borla Performance").
const GENERIC_WORDS = new Set([
	'4x4', 'accessories', 'and', 'auto', 'automotive', 'axle', 'batteries', 'brand', 'co', 'dynamics',
	'engineering', 'filters', 'gear', 'inc', 'industries', 'lighting', 'manufacturing', 'map', 'mfg', 'off',
	'offroad', 'performance', 'power', 'products', 'race', 'racing', 'road', 'security', 'shocks', 'suspension',
	'suspensions', 'systems', 'technology', 'the', 'tire', 'tires', 'usa', 'wheel', 'wheels',
]);

const words = (text) => String(text ?? '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
const compact = (text) => words(text).join('');
function core(text) {
	const all = words(text);
	const kept = all.filter((w) => !GENERIC_WORDS.has(w));
	return (kept.length ? kept : all).join('');
}

function candidatesBy(key, labels, rows) {
	const wanted = new Set(labels.map(key).filter(Boolean));
	const byPrefix = new Map();
	for (const row of rows) {
		if (!row.jj_prefix || !row.brand_name || !wanted.has(key(row.brand_name))) continue;
		if (!byPrefix.has(row.jj_prefix)) byPrefix.set(row.jj_prefix, { jj_prefix: row.jj_prefix, brand_name: row.brand_name });
	}
	return [...byPrefix.values()];
}

function suggestBrandMatch(brand, vendorsPrefix) {
	const labels = brand.labels && brand.labels.length ? brand.labels : [brand.label];
	const exact = candidatesBy(compact, labels, vendorsPrefix);
	const candidates = exact.length ? exact : candidatesBy(core, labels, vendorsPrefix);
	if (candidates.length === 0) return { tier: 'unmapped', candidates };
	if (candidates.length > 1) return { tier: 'ambiguous', candidates };
	return { tier: exact.length ? 'exact' : 'loose', candidates };
}

// The literal text Niagara puts before the manufacturer part number: "BIL-",
// "WARN-", "RCS" (Rough Country, no dash) or "" (Rugged Ridge, bare number).
function prefixOf(sku) {
	const text = String(sku ?? '').trim().toUpperCase();
	const dashed = text.match(/^([A-Z][A-Z0-9&]{1,11}-)/);
	if (dashed && /[0-9A-Z]/.test(text.slice(dashed[1].length, dashed[1].length + 1))) return dashed[1];
	const letters = text.match(/^([A-Z&]+)(?=\d)/);
	return letters ? letters[1] : '';
}

function mostCommon(values) {
	const counts = new Map();
	for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0] || ['', 0];
}

function inferSkuPrefix(skus, sampleSize = 5) {
	const list = (skus || []).map((s) => String(s ?? '').trim()).filter(Boolean);
	if (!list.length) return { prefix: '', share: 0, samples: [] };
	const [prefix, count] = mostCommon(list.map(prefixOf));
	return { prefix, share: count / list.length, samples: list.slice(0, sampleSize) };
}

function dominantVendor(vendorLabels) {
	const list = (vendorLabels || []).map((v) => String(v ?? '').trim()).filter(Boolean);
	if (!list.length) return { vendor: '', share: 0 };
	const [key, count] = mostCommon(list.map((v) => v.toUpperCase()));
	return { vendor: key, share: count / list.length };
}

module.exports = { suggestBrandMatch, inferSkuPrefix, dominantVendor, compact, core };
