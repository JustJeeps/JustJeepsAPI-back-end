const test = require('node:test');
const assert = require('node:assert');

const { makePrismaStub } = require('./prismaStub');
const { createProductReplacementsService } = require('../../../services/productReplacements/productReplacementsService');
const { ProductReplacementError } = require('../../../services/productReplacements/errors');
const { createOmixOeImportService, findImportUser, CATALOG_CHUNK_SIZE } = require('../../../services/productReplacements/omixOeImportService');

const OMIX = (sku, replaceOe, vendors = 'Omix-ADA, Quadratec, Keystone, Meyer') => ({ sku, name: `Omix ${sku}`, replace_oe: replaceOe, vendors });
const CROWN = (sku) => ({ sku, name: `Crown ${sku}`, replace_oe: null, vendors: 'Keystone, Meyer, Quadratec' });

const PRODUCTS = [
	OMIX('OA-17701.01', '52002750'),
	OMIX('OA-18282.05', '53010591'),
	OMIX('OA-99', '777'),
	{ sku: 'RUG-1', name: 'Rugged', replace_oe: '52002750', vendors: 'Rugged Ridge' },
	CROWN('CRO-J52002750'),
	CROWN('CRO-J0052002750'),
	CROWN('CRO-53010591'),
];

const ADMIN = { id: 4, username: 'admin' };
const CONFIG = { skuMaxLength: 64, commentMaxLength: 2000, listPageSize: 50, listPageSizeMax: 100, countsMaxSkus: 200, createMaxBatch: 20 };
const silentLog = { log() {}, warn() {}, error() {} };

function makeImport(prisma, overrides = {}) {
	const replacementsService = createProductReplacementsService({ prisma, config: CONFIG, isManager: () => false });
	return createOmixOeImportService({ prisma, replacementsService, log: silentLog, ...overrides });
}

test('dry run reports the plan and writes nothing', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const report = await makeImport(prisma).run({ user: ADMIN, confirm: false });

	assert.strictEqual(report.confirm, false);
	assert.strictEqual(report.totals.sources, 3);
	assert.strictEqual(report.totals.groups, 2);
	assert.strictEqual(report.totals.pairsToCreate, 3);
	assert.strictEqual(report.skipped.noVariantInCatalog, 1);
	assert.strictEqual(report.created, 0);
	assert.deepStrictEqual(report.failed, []);
	assert.strictEqual(prisma.replacements.length, 0);
});

test('only Omix-ADA products with a replace_oe are loaded from the catalog', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	await makeImport(prisma).run({ user: ADMIN, confirm: false });

	const sourceQuery = prisma.productFindManyCalls[0];
	assert.deepStrictEqual(sourceQuery.where, {
		replace_oe: { not: null },
		vendors: { contains: 'omix-ada', mode: 'insensitive' },
	});
	assert.deepStrictEqual(sourceQuery.select, { sku: true, replace_oe: true });
});

test('confirm creates the pairs through the replacements service with the admin as creator and comment author', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const report = await makeImport(prisma).run({ user: ADMIN, confirm: true });

	assert.strictEqual(report.created, 3);
	assert.deepStrictEqual(report.failed, []);
	const pairs = prisma.replacements.map((row) => [row.source_sku, row.replacement_sku, row.kind, row.created_by_id]);
	assert.deepStrictEqual(pairs, [
		['OA-17701.01', 'CRO-J52002750', 'replacement', 4],
		['OA-17701.01', 'CRO-J0052002750', 'replacement', 4],
		['OA-18282.05', 'CRO-53010591', 'replacement', 4],
	]);
	assert.strictEqual(prisma.comments.length, 3);
	assert.ok(prisma.comments.every((comment) => comment.author_id === 4));
	assert.strictEqual(
		prisma.comments[2].body,
		'Replace OE 53010591 from the Omix OE file (automatic). Equivalent parts: OA-18282.05, CRO-53010591. Other Crown candidates not in the catalog: CRO-J53010591, CRO-J053010591, CRO-J0053010591.'
	);
});

test('a second run creates nothing and reports the pairs as already active', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const importer = makeImport(prisma);
	await importer.run({ user: ADMIN, confirm: true });
	const report = await importer.run({ user: ADMIN, confirm: true });

	assert.strictEqual(report.created, 0);
	assert.strictEqual(report.skipped.alreadyActive, 3);
	assert.strictEqual(prisma.replacements.length, 3);
});

test('a pair removed by hand is not recreated', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const importer = makeImport(prisma);
	await importer.run({ user: ADMIN, confirm: true });
	prisma.replacements[0].deletedAt = new Date();
	prisma.replacements[0].deletedById = 2;

	const report = await importer.run({ user: ADMIN, confirm: true });

	assert.strictEqual(report.created, 0);
	assert.strictEqual(report.skipped.removedBefore, 1);
	assert.strictEqual(report.skipped.alreadyActive, 2);
});

test('a source marked as having no replacement is skipped and reported, not written', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const replacementsService = createProductReplacementsService({ prisma, config: CONFIG, isManager: () => false });
	await replacementsService.createReplacements({ user: { id: 2 }, source_sku: 'OA-17701.01', no_replacement: true, comment: 'Discontinued, no Crown equivalent.' });

	const report = await makeImport(prisma, { replacementsService }).run({ user: ADMIN, confirm: true });

	assert.deepStrictEqual(report.skipped.blockedByMarker, ['OA-17701.01']);
	assert.strictEqual(report.created, 1);
	assert.strictEqual(prisma.replacements.filter((row) => row.kind === 'replacement').length, 1);
});

test('a business rule error from the service is recorded per source and the run continues', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const real = createProductReplacementsService({ prisma, config: CONFIG, isManager: () => false });
	const replacementsService = {
		createReplacements: async (input) => {
			if (input.source_sku === 'OA-17701.01') {
				throw ProductReplacementError.conflict('DUPLICATE_REPLACEMENT', 'raced');
			}
			return real.createReplacements(input);
		},
	};

	const report = await makeImport(prisma, { replacementsService }).run({ user: ADMIN, confirm: true });

	assert.deepStrictEqual(report.failed, [{ source_sku: 'OA-17701.01', pairs: 2, code: 'DUPLICATE_REPLACEMENT', message: 'raced' }]);
	assert.strictEqual(report.created, 1);
	assert.strictEqual(report.pairsNotCreated, 2);
});

test('an unexpected error stops the run and carries what was done so far', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const real = createProductReplacementsService({ prisma, config: CONFIG, isManager: () => false });
	let calls = 0;
	const replacementsService = {
		createReplacements: async (input) => {
			calls += 1;
			if (calls === 2) throw Object.assign(new Error('connection lost'), { code: 'P1001' });
			return real.createReplacements(input);
		},
	};

	await assert.rejects(makeImport(prisma, { replacementsService }).run({ user: ADMIN, confirm: true }), (error) => {
		assert.strictEqual(error.message, 'connection lost');
		assert.deepStrictEqual(error.partialReport, { created: 2, failed: [], processed: 1, total: 2 });
		return true;
	});
	assert.strictEqual(prisma.replacements.length, 2, 'the first source was committed and stays');
});

test('the catalog check for Crown candidates runs in chunks', async () => {
	const products = Array.from({ length: 300 }, (_, i) => OMIX(`OA-${i}`, `${1000 + i}`));
	const prisma = makePrismaStub({ products });
	await makeImport(prisma).run({ user: ADMIN, confirm: false });

	const catalogCalls = prisma.productFindManyCalls.slice(1);
	assert.strictEqual(catalogCalls.length, 2);
	assert.strictEqual(catalogCalls[0].where.sku.in.length, CATALOG_CHUNK_SIZE);
	assert.strictEqual(catalogCalls[1].where.sku.in.length, 200);
	assert.deepStrictEqual(catalogCalls[0].select, { sku: true });
});

test('existing rows are loaded with the Omix SKUs on either side of the pair', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	await makeImport(prisma).run({ user: ADMIN, confirm: false });

	const where = prisma.replacementFindManyCalls[0].where;
	const omix = ['OA-18282.05', 'OA-17701.01', 'OA-99'].sort();
	assert.deepStrictEqual([...where.OR[0].source_sku.in].sort(), omix);
	assert.deepStrictEqual([...where.OR[1].replacement_sku.in].sort(), omix);
});

test('a pair registered by hand the other way round and then removed is not recreated', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const replacementsService = createProductReplacementsService({ prisma, config: CONFIG, isManager: () => false });
	const [row] = await replacementsService.createReplacements({ user: { id: 2 }, source_sku: 'CRO-53010591', replacements: [{ replacement_sku: 'OA-18282.05' }] });
	await replacementsService.removeReplacement({ user: { id: 2, username: 'tess' }, id: row.id });

	const report = await makeImport(prisma, { replacementsService }).run({ user: ADMIN, confirm: true });

	assert.strictEqual(report.skipped.removedBefore, 1);
	assert.deepStrictEqual(prisma.replacements.filter((r) => r.deletedAt === null).map((r) => [r.source_sku, r.replacement_sku]), [
		['OA-17701.01', 'CRO-J52002750'],
		['OA-17701.01', 'CRO-J0052002750'],
	]);
});

test('findImportUser matches the username without case and returns null when missing', async () => {
	const prisma = makePrismaStub();
	const user = await findImportUser(prisma, 'ADMIN');
	assert.deepStrictEqual(user, { id: 4, username: 'admin', email: 'admin@x', firstname: 'Admin', lastname: '' });
	assert.strictEqual(await findImportUser(prisma, 'nobody'), null);
});

test('findImportUser refuses an ambiguous username instead of picking one', async () => {
	const prisma = makePrismaStub({ extraUsers: [{ id: 17, username: 'Admin', email: 'admin2@x', firstname: 'Other', lastname: 'Admin' }] });
	await assert.rejects(findImportUser(prisma, 'admin'), /User "admin" matches 2 accounts \(ids 4, 17\); pass the exact username/);
	await assert.rejects(findImportUser(prisma, '  '), /username is required/);
});
