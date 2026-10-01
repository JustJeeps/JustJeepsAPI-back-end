const test = require('node:test');
const assert = require('node:assert');

const {
	buildCrownVariants,
	detectOeAnomalies,
	buildGroupComment,
	planOmixOeImport,
} = require('../../../lib/productReplacements/omixOeImport');

test('buildCrownVariants returns the four Crown part numbers in the Items screen order', () => {
	assert.deepStrictEqual(buildCrownVariants('52002750'), [
		'CRO-52002750',
		'CRO-J52002750',
		'CRO-J052002750',
		'CRO-J0052002750',
	]);
});

test('buildCrownVariants trims the value and returns nothing for a blank one', () => {
	assert.deepStrictEqual(buildCrownVariants(' 3227329 ')[0], 'CRO-3227329');
	assert.deepStrictEqual(buildCrownVariants(''), []);
	assert.deepStrictEqual(buildCrownVariants('   '), []);
	assert.deepStrictEqual(buildCrownVariants(null), []);
	assert.deepStrictEqual(buildCrownVariants(undefined), []);
});

test('detectOeAnomalies flags several values, a J prefix and a leading zero', () => {
	assert.deepStrictEqual(detectOeAnomalies('123,456'), ['MULTI_VALUE']);
	assert.deepStrictEqual(detectOeAnomalies('123; 456'), ['MULTI_VALUE']);
	assert.deepStrictEqual(detectOeAnomalies('123/456'), ['MULTI_VALUE']);
	assert.deepStrictEqual(detectOeAnomalies('123 456'), ['MULTI_VALUE']);
	assert.deepStrictEqual(detectOeAnomalies('J8127630'), ['J_PREFIX']);
	assert.deepStrictEqual(detectOeAnomalies('j8127630'), ['J_PREFIX']);
	assert.deepStrictEqual(detectOeAnomalies('0123'), ['LEADING_ZERO']);
	assert.deepStrictEqual(detectOeAnomalies('0123, J456'), ['MULTI_VALUE', 'LEADING_ZERO']);
	assert.deepStrictEqual(detectOeAnomalies('52002750'), []);
});

test('buildGroupComment names the OE, the equivalent parts and the Crown candidates not in the catalog', () => {
	assert.strictEqual(
		buildGroupComment({ replaceOe: '52002750', members: ['OA-17701.01', 'CRO-J52002750'], missingVariants: ['CRO-52002750', 'CRO-J052002750', 'CRO-J0052002750'] }),
		'Replace OE 52002750 from the Omix OE file (automatic). Equivalent parts: OA-17701.01, CRO-J52002750. Other Crown candidates not in the catalog: CRO-52002750, CRO-J052002750, CRO-J0052002750.'
	);
});

test('buildGroupComment omits the last sentence when every candidate exists', () => {
	assert.strictEqual(
		buildGroupComment({ replaceOe: '52002750', members: ['OA-1', 'CRO-52002750'], missingVariants: [] }),
		'Replace OE 52002750 from the Omix OE file (automatic). Equivalent parts: OA-1, CRO-52002750.'
	);
});

const OMIX = (sku, replaceOe) => ({ sku, replace_oe: replaceOe });
const pairsOf = (plan) => plan.creates.map((entry) => [entry.source_sku, entry.replacements.map((r) => r.replacement_sku)]);

test('planOmixOeImport creates one pair per Crown variant in the catalog (the lookup closes the other directions)', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-17701.01', '52002750')],
		catalogSkus: new Set(['OA-17701.01', 'CRO-J52002750', 'CRO-J0052002750']),
		existingRows: [],
	});

	assert.deepStrictEqual(pairsOf(plan), [['OA-17701.01', ['CRO-J52002750', 'CRO-J0052002750']]]);
	const comment = 'Replace OE 52002750 from the Omix OE file (automatic). Equivalent parts: OA-17701.01, CRO-J52002750, CRO-J0052002750. Other Crown candidates not in the catalog: CRO-52002750, CRO-J052002750.';
	assert.ok(plan.creates.every((entry) => entry.replacements.every((r) => r.comment === comment)));
	assert.strictEqual(plan.totals.groups, 1);
	assert.strictEqual(plan.totals.pairsToCreate, 2);
	assert.strictEqual(plan.skipped.noVariantInCatalog, 0);
});

test('planOmixOeImport counts products whose Crown variants are all missing from the catalog', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-1', '111'), OMIX('OA-2', '222')],
		catalogSkus: new Set(['OA-1', 'OA-2', 'CRO-J222']),
		existingRows: [],
	});

	assert.deepStrictEqual(pairsOf(plan), [['OA-2', ['CRO-J222']]]);
	assert.strictEqual(plan.skipped.noVariantInCatalog, 1);
	assert.strictEqual(plan.totals.groups, 1);
});

test('planOmixOeImport lists both Omix products of a shared OE as equivalents, each pointing to the Crown part', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-1', '111'), OMIX('OA-2', '111')],
		catalogSkus: new Set(['OA-1', 'OA-2', 'CRO-111']),
		existingRows: [],
	});

	assert.deepStrictEqual(pairsOf(plan), [['OA-1', ['CRO-111']], ['OA-2', ['CRO-111']]]);
	assert.ok(plan.creates[0].replacements[0].comment.includes('Equivalent parts: OA-1, OA-2, CRO-111.'));
	assert.strictEqual(plan.totals.groups, 1);
	assert.strictEqual(plan.totals.pairsToCreate, 2);
});

test('planOmixOeImport leaves anomalous OE values to a human and reports them', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-1', '0123'), OMIX('OA-2', 'J456'), OMIX('OA-3', '7, 8'), OMIX('OA-4', '   ')],
		catalogSkus: new Set(['CRO-J00123', 'CRO-JJ456', 'CRO-7, 8']),
		existingRows: [],
	});

	assert.deepStrictEqual(plan.creates, []);
	assert.deepStrictEqual(plan.skipped.anomalies, [
		{ sku: 'OA-1', replace_oe: '0123', anomalies: ['LEADING_ZERO'] },
		{ sku: 'OA-2', replace_oe: 'J456', anomalies: ['J_PREFIX'] },
		{ sku: 'OA-3', replace_oe: '7, 8', anomalies: ['MULTI_VALUE'] },
	]);
	assert.strictEqual(plan.skipped.blankOe, 1);
	assert.strictEqual(plan.totals.groups, 0);
});

test('planOmixOeImport skips pairs that are already active and pairs that were removed by hand', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-1', '111')],
		catalogSkus: new Set(['OA-1', 'CRO-111', 'CRO-J111', 'CRO-J0111']),
		existingRows: [
			{ source_sku: 'OA-1', replacement_sku: 'CRO-111', kind: 'replacement', deletedAt: null },
			{ source_sku: 'OA-1', replacement_sku: 'CRO-J111', kind: 'replacement', deletedAt: new Date('2026-09-26T10:00:00Z') },
		],
	});

	assert.deepStrictEqual(pairsOf(plan), [['OA-1', ['CRO-J0111']]]);
	assert.strictEqual(plan.skipped.alreadyActive, 1);
	assert.strictEqual(plan.skipped.removedBefore, 1);
});

test('planOmixOeImport skips a source with an active "no replacement" marker but not a removed one', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-1', '111'), OMIX('OA-2', '222')],
		catalogSkus: new Set(['OA-1', 'OA-2', 'CRO-111', 'CRO-222']),
		existingRows: [
			{ source_sku: 'OA-1', replacement_sku: null, kind: 'none', deletedAt: null },
			{ source_sku: 'OA-2', replacement_sku: null, kind: 'none', deletedAt: new Date('2026-09-26T10:00:00Z') },
		],
	});

	assert.deepStrictEqual(pairsOf(plan), [['OA-2', ['CRO-222']]]);
	assert.deepStrictEqual(plan.skipped.blockedByMarker, ['OA-1']);
});

test('planOmixOeImport ignores rows of other sources and never pairs a product with itself', () => {
	const plan = planOmixOeImport({
		products: [OMIX('CRO-111', '111')],
		catalogSkus: new Set(['CRO-111', 'CRO-J111']),
		existingRows: [{ source_sku: 'OA-OTHER', replacement_sku: 'CRO-J111', kind: 'replacement', deletedAt: null }],
	});

	assert.deepStrictEqual(pairsOf(plan), [['CRO-111', ['CRO-J111']]]);
	assert.strictEqual(plan.skipped.alreadyActive, 0);
});

test('planOmixOeImport treats a pair registered the other way round as the same link', () => {
	const plan = planOmixOeImport({
		products: [OMIX('OA-1', '111')],
		catalogSkus: new Set(['OA-1', 'CRO-111', 'CRO-J111', 'CRO-J0111']),
		existingRows: [
			{ source_sku: 'CRO-111', replacement_sku: 'OA-1', kind: 'replacement', deletedAt: null },
			{ source_sku: 'CRO-J111', replacement_sku: 'OA-1', kind: 'replacement', deletedAt: new Date('2026-09-26T10:00:00Z') },
		],
	});

	assert.deepStrictEqual(pairsOf(plan), [['OA-1', ['CRO-J0111']]]);
	assert.strictEqual(plan.skipped.alreadyActive, 1);
	assert.strictEqual(plan.skipped.removedBefore, 1);
});

test('buildGroupComment stays within the comment limit by shortening the lists', () => {
	const members = Array.from({ length: 150 }, (_, i) => `OA-${10000 + i}.01`);
	const missing = ['CRO-1', 'CRO-J1', 'CRO-J01'];
	const comment = buildGroupComment({ replaceOe: '1', members, missingVariants: missing, maxLength: 2000 });
	assert.ok(comment.length <= 2000, `comment has ${comment.length} chars`);
	assert.ok(comment.startsWith('Replace OE 1 from the Omix OE file (automatic). Equivalent parts: OA-10000.01, '));
	assert.match(comment, /and \d+ more\./);
	assert.strictEqual(
		buildGroupComment({ replaceOe: '1', members: ['OA-1', 'CRO-1'], missingVariants: [], maxLength: 2000 }),
		'Replace OE 1 from the Omix OE file (automatic). Equivalent parts: OA-1, CRO-1.'
	);
});

test('planOmixOeImport passes the comment limit on to the group comment', () => {
	const products = Array.from({ length: 150 }, (_, i) => OMIX(`OA-${10000 + i}.01`, '1'));
	const plan = planOmixOeImport({ products, catalogSkus: new Set(['CRO-1']), existingRows: [], commentMaxLength: 2000 });
	assert.ok(plan.creates.every((entry) => entry.replacements.every((r) => r.comment.length <= 2000)));
});
