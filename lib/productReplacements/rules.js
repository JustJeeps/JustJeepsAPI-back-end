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

module.exports = {
	REPLACEMENT_KINDS,
	isNoneMarker,
	hasActiveReplacements,
	hasNoneMarker,
	normalizeSku,
	isSelfReplacement,
	canRemoveReplacement,
	canRemoveComment,
	groupBySourceSku,
};
