// Pure rules of the Product Replacement feature (docs/PRODUCT-REPLACEMENTS.md).
// No I/O here: everything is testable without a database.

// Product.sku is the primary key and is case sensitive, so a SKU is only
// trimmed, never upper/lower cased, before it is stored or looked up.
function normalizeSku(value) {
	if (value === null || value === undefined) return '';
	return String(value).trim();
}

// BR-06: a SKU cannot replace itself. Compared without case so "abc-100" is
// not accepted as a replacement for "ABC-100" by accident.
function isSelfReplacement(sourceSku, replacementSku) {
	const source = normalizeSku(sourceSku).toLowerCase();
	const replacement = normalizeSku(replacementSku).toLowerCase();
	return source !== '' && source === replacement;
}

// Removing an association: its creator or a manager (REPLACEMENTS_MANAGER_USERS).
function canRemoveReplacement({ replacement, user, isManager }) {
	if (!replacement || !user) return false;
	return isManager === true || replacement.created_by_id === user.id;
}

// Removing a comment: its author or a manager.
function canRemoveComment({ comment, user, isManager }) {
	if (!comment || !user) return false;
	return isManager === true || comment.author_id === user.id;
}

// Directory view: one group per original product, in first-seen order.
function groupBySourceSku(rows) {
	const groups = new Map();
	for (const row of rows || []) {
		if (!groups.has(row.source_sku)) {
			groups.set(row.source_sku, { source_sku: row.source_sku, replacements: [] });
		}
		groups.get(row.source_sku).replacements.push(row);
	}
	return [...groups.values()];
}

// A row is a replacement pair or a "no replacement" marker (kind 'none',
// replacement_sku null). Rows created before the column count as pairs.
const REPLACEMENT_KINDS = ['replacement', 'none'];

function isNoneMarker(row) {
	return Boolean(row) && row.kind === 'none';
}

const isActive = (row) => Boolean(row) && (row.deletedAt === null || row.deletedAt === undefined);

function hasActiveReplacements(rows) {
	return (rows || []).some((row) => isActive(row) && !isNoneMarker(row));
}

function hasNoneMarker(rows) {
	return (rows || []).some((row) => isActive(row) && isNoneMarker(row));
}

// Lookup: the parts linked to `rootSku` through active pairs, whichever side
// they were registered on, following the links a few hops away. Order: the
// pairs registered for the root first, then the pairs that point to it, then
// what those parts link to. Each part appears once, with the row that links it
// and the part it was reached through (`via`). Markers are not links.
function collectEquivalents(rootSku, rows, { maxHops = 4 } = {}) {
	const links = (rows || []).filter((row) => isActive(row) && !isNoneMarker(row) && row.replacement_sku);
	const found = [];
	const seen = new Set([rootSku]);
	let frontier = [rootSku];
	for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
		const next = [];
		const add = (sku, row, relation, via) => {
			if (seen.has(sku)) return;
			seen.add(sku);
			found.push({ sku, row, relation, via });
			next.push(sku);
		};
		for (const node of frontier) {
			for (const row of links) {
				if (row.source_sku === node) add(row.replacement_sku, row, hop === 1 ? 'registered' : 'linked', node);
			}
			for (const row of links) {
				if (row.replacement_sku === node) add(row.source_sku, row, hop === 1 ? 'reverse' : 'linked', node);
			}
		}
		frontier = next;
	}
	return found;
}

module.exports = {
	REPLACEMENT_KINDS,
	collectEquivalents,
	isNoneMarker,
	hasActiveReplacements,
	hasNoneMarker,
	normalizeSku,
	isSelfReplacement,
	canRemoveReplacement,
	canRemoveComment,
	groupBySourceSku,
};
