const test = require('node:test');
const assert = require('node:assert');

const {
	normalizeSku,
	isSelfReplacement,
	canRemoveReplacement,
	canRemoveComment,
	groupBySourceSku,
} = require('../../../lib/productReplacements/rules');

test('normalizeSku trims and keeps the case (Product.sku is case sensitive)', () => {
	assert.strictEqual(normalizeSku('  CRO-83503077 '), 'CRO-83503077');
	assert.strictEqual(normalizeSku('abc-100'), 'abc-100');
	assert.strictEqual(normalizeSku(null), '');
	assert.strictEqual(normalizeSku(undefined), '');
	assert.strictEqual(normalizeSku(42), '42');
});

test('isSelfReplacement flags the same SKU regardless of spacing and case', () => {
	assert.strictEqual(isSelfReplacement('ABC-100', 'ABC-100'), true);
	assert.strictEqual(isSelfReplacement(' ABC-100', 'abc-100 '), true);
	assert.strictEqual(isSelfReplacement('ABC-100', 'XYZ-200'), false);
});

test('canRemoveReplacement allows the creator and managers only', () => {
	const replacement = { created_by_id: 7 };
	assert.strictEqual(canRemoveReplacement({ replacement, user: { id: 7 }, isManager: false }), true);
	assert.strictEqual(canRemoveReplacement({ replacement, user: { id: 8 }, isManager: false }), false);
	assert.strictEqual(canRemoveReplacement({ replacement, user: { id: 8 }, isManager: true }), true);
	assert.strictEqual(canRemoveReplacement({ replacement, user: null, isManager: true }), false);
	assert.strictEqual(canRemoveReplacement({ replacement: null, user: { id: 7 }, isManager: true }), false);
});

test('canRemoveComment allows the author and managers only', () => {
	const comment = { author_id: 3 };
	assert.strictEqual(canRemoveComment({ comment, user: { id: 3 }, isManager: false }), true);
	assert.strictEqual(canRemoveComment({ comment, user: { id: 4 }, isManager: false }), false);
	assert.strictEqual(canRemoveComment({ comment, user: { id: 4 }, isManager: true }), true);
	assert.strictEqual(canRemoveComment({ comment: null, user: { id: 3 }, isManager: true }), false);
});

test('groupBySourceSku keeps first-seen order and nests replacements', () => {
	const rows = [
		{ id: 1, source_sku: 'A', replacement_sku: 'B' },
		{ id: 2, source_sku: 'C', replacement_sku: 'D' },
		{ id: 3, source_sku: 'A', replacement_sku: 'E' },
	];
	assert.deepStrictEqual(groupBySourceSku(rows), [
		{ source_sku: 'A', replacements: [rows[0], rows[2]] },
		{ source_sku: 'C', replacements: [rows[1]] },
	]);
	assert.deepStrictEqual(groupBySourceSku([]), []);
});

const { REPLACEMENT_KINDS, isNoneMarker, hasActiveReplacements, hasNoneMarker } = require('../../../lib/productReplacements/rules');

test('kinds: a row is either a replacement pair or a "no replacement" marker', () => {
	assert.deepStrictEqual(REPLACEMENT_KINDS, ['replacement', 'none']);
	assert.strictEqual(isNoneMarker({ kind: 'none', replacement_sku: null }), true);
	assert.strictEqual(isNoneMarker({ kind: 'replacement', replacement_sku: 'B' }), false);
	assert.strictEqual(isNoneMarker({ replacement_sku: 'B' }), false, 'rows from before the column default to a pair');
	assert.strictEqual(isNoneMarker(null), false);
});

test('hasActiveReplacements / hasNoneMarker look only at active rows', () => {
	const rows = [
		{ kind: 'replacement', deletedAt: null },
		{ kind: 'none', deletedAt: new Date() },
	];
	assert.strictEqual(hasActiveReplacements(rows), true);
	assert.strictEqual(hasNoneMarker(rows), false, 'a removed marker does not count');
	assert.strictEqual(hasNoneMarker([{ kind: 'none', deletedAt: null }]), true);
	assert.strictEqual(hasActiveReplacements([{ kind: 'replacement', deletedAt: new Date() }]), false);
	assert.strictEqual(hasActiveReplacements([]), false);
});
