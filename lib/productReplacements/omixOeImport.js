// Pure rules for turning Omix-ADA "Replace OE" numbers into Product Replacement
// pairs (docs/PRODUCT-REPLACEMENTS.md, "Automatic rows from the Omix OE file").
// No I/O here: the service loads products, catalog SKUs and existing rows, and
// this module decides what to create and what to leave to a human.

const { normalizeSku, isNoneMarker, isSelfReplacement } = require('./rules');

const CROWN_PREFIXES = ['CRO-', 'CRO-J', 'CRO-J0', 'CRO-J00'];

// Same four candidates, in the same order, as buildCroSkuVariants on the Items
// screen of the frontend. The value is trimmed and otherwise kept verbatim.
function buildCrownVariants(replaceOe) {
	const base = normalizeSku(replaceOe);
	if (!base) return [];
	return CROWN_PREFIXES.map((prefix) => `${prefix}${base}`);
}

// Values the script must not turn into pairs on its own: several OE numbers in
// one cell, a value that is already a Crown number (J prefix) and a leading zero
// (CRO-J0 of "0123" is CRO-J00123, which is also CRO-J00 of "123").
function detectOeAnomalies(replaceOe) {
	const value = normalizeSku(replaceOe);
	const anomalies = [];
	if (/[,;/\s]/.test(value)) anomalies.push('MULTI_VALUE');
	if (/^j/i.test(value)) anomalies.push('J_PREFIX');
	if (/^0/.test(value)) anomalies.push('LEADING_ZERO');
	return anomalies;
}

// What the buyer reads as "Latest comment" on every pair of an OE group. Kept
// within the comment limit of the feature: when a group is huge the member
// list is cut ("and N more") and, if that is still not enough, the list of
// candidates not in the catalog is dropped.
function buildGroupComment({ replaceOe, members, missingVariants = [], maxLength = Infinity }) {
	const head = `Replace OE ${normalizeSku(replaceOe)} from the Omix OE file (automatic).`;
	const tail = missingVariants.length > 0 ? ` Other Crown candidates not in the catalog: ${missingVariants.join(', ')}.` : '';
	const membersSentence = (shown) => {
		const rest = members.length - shown.length;
		return ` Equivalent parts: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`;
	};
	const full = `${head}${membersSentence(members)}${tail}`;
	if (full.length <= maxLength) return full;
	for (let keep = members.length - 1; keep >= 1; keep -= 1) {
		const shorter = `${head}${membersSentence(members.slice(0, keep))}${tail}`;
		if (shorter.length <= maxLength) return shorter;
	}
	return `${head}${membersSentence(members.slice(0, 1))}`;
}

const isActive = (row) => row.deletedAt === null || row.deletedAt === undefined;

// Decide the pairs to create: one Omix -> Crown pair per Crown variant in the
// catalog. The parts that share one OE number are equivalents, and the
// Replacements lookup is symmetric and follows links, so the Crown part shows
// the Omix part and its sibling variants without extra rows. The comment names
// the whole group.
//
// `existingRows` holds active AND soft-deleted rows touching the Omix sources
// on either side: a pair removed by hand, whichever way it was registered, is a
// team decision and is never recreated; an active "no replacement" marker
// blocks that source.
function planOmixOeImport({ products, catalogSkus, existingRows, commentMaxLength = Infinity }) {
	// Rows touching a SKU on either side: the lookup is symmetric, so a pair
	// registered as Crown -> Omix is the same link as Omix -> Crown.
	const rowsByEndpoint = new Map();
	const index = (sku, row) => {
		if (!sku) return;
		if (!rowsByEndpoint.has(sku)) rowsByEndpoint.set(sku, []);
		rowsByEndpoint.get(sku).push(row);
	};
	for (const row of existingRows || []) {
		index(row.source_sku, row);
		if (row.replacement_sku !== row.source_sku) index(row.replacement_sku, row);
	}
	const samePair = (row, a, b) => !isNoneMarker(row)
		&& ((row.source_sku === a && row.replacement_sku === b) || (row.source_sku === b && row.replacement_sku === a));

	const skipped = { anomalies: [], blankOe: 0, noVariantInCatalog: 0, alreadyActive: 0, removedBefore: 0, blockedByMarker: [] };
	const groups = new Map();

	for (const product of products) {
		const replaceOe = normalizeSku(product.replace_oe);
		if (!replaceOe) {
			skipped.blankOe += 1;
			continue;
		}
		const anomalies = detectOeAnomalies(replaceOe);
		if (anomalies.length > 0) {
			skipped.anomalies.push({ sku: product.sku, replace_oe: replaceOe, anomalies });
			continue;
		}

		const variants = buildCrownVariants(replaceOe);
		const crownSkus = variants.filter((sku) => catalogSkus.has(sku));
		if (crownSkus.length === 0) {
			skipped.noVariantInCatalog += 1;
			continue;
		}

		if (!groups.has(replaceOe)) {
			groups.set(replaceOe, {
				replaceOe,
				omixSkus: [],
				crownSkus,
				missingVariants: variants.filter((sku) => !catalogSkus.has(sku)),
			});
		}
		groups.get(replaceOe).omixSkus.push(product.sku);
	}

	const creates = [];
	for (const group of groups.values()) {
		// A product whose own SKU is one of its Crown candidates counts once, as Omix.
		const crownSkus = group.crownSkus.filter((sku) => !group.omixSkus.includes(sku));
		const members = [...group.omixSkus, ...crownSkus];
		const comment = buildGroupComment({ replaceOe: group.replaceOe, members, missingVariants: group.missingVariants, maxLength: commentMaxLength });

		for (const source of group.omixSkus) {
			const rows = rowsByEndpoint.get(source) || [];
			if (rows.some((row) => row.source_sku === source && isActive(row) && isNoneMarker(row))) {
				skipped.blockedByMarker.push(source);
				continue;
			}

			const replacements = [];
			for (const target of crownSkus) {
				if (isSelfReplacement(source, target)) continue;
				const existing = rows.filter((row) => samePair(row, source, target));
				if (existing.some(isActive)) {
					skipped.alreadyActive += 1;
				} else if (existing.length > 0) {
					skipped.removedBefore += 1;
				} else {
					replacements.push({ replacement_sku: target, comment });
				}
			}
			if (replacements.length > 0) creates.push({ source_sku: source, replacements });
		}
	}

	const totals = {
		sources: products.length,
		groups: groups.size,
		pairsToCreate: creates.reduce((sum, entry) => sum + entry.replacements.length, 0),
	};
	return { creates, skipped, totals };
}

module.exports = {
	buildCrownVariants,
	detectOeAnomalies,
	buildGroupComment,
	planOmixOeImport,
};
