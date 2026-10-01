const test = require('node:test');
const assert = require('node:assert');

const { createProductReplacementsService } = require('../../../services/productReplacements/productReplacementsService');
const { ProductReplacementError } = require('../../../services/productReplacements/errors');

const { makePrismaStub, PRODUCTS } = require('./prismaStub');

const PAULA = { id: 1, username: 'paula' };
const TESS = { id: 2, username: 'tess' };
const RICARDO = { id: 3, username: 'ricardo' };

const CONFIG = { managers: ['ricardo'], skuMaxLength: 64, commentMaxLength: 2000, listMax: 500, countsMaxSkus: 200, createMaxBatch: 20 };

function makeService(prisma) {
	return createProductReplacementsService({
		prisma,
		isManager: (username) => CONFIG.managers.includes(username),
		config: CONFIG,
	});
}

async function rejectsWith(promise, code, httpStatus) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof ProductReplacementError, `expected ProductReplacementError, got ${error?.constructor?.name}: ${error?.message}`);
		assert.strictEqual(error.code, code);
		if (httpStatus) assert.strictEqual(error.httpStatus, httpStatus);
		return true;
	});
}

test('createReplacements stores one association per replacement with the creator and its comment', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);

	const created = await service.createReplacements({
		user: PAULA,
		source_sku: ' CRO-83503077 ',
		replacements: [
			{ replacement_sku: 'MOO-RK620185', comment: 'Customer approval is required.' },
			{ replacement_sku: 'OMX-18282.05' },
		],
	});

	assert.strictEqual(created.length, 2);
	assert.strictEqual(created[0].source_sku, 'CRO-83503077');
	assert.strictEqual(created[0].replacement_sku, 'MOO-RK620185');
	assert.strictEqual(created[0].createdBy.username, 'paula');
	assert.strictEqual(created[0].comments.length, 1);
	assert.strictEqual(created[0].comments[0].body, 'Customer approval is required.');
	assert.strictEqual(created[0].comments[0].author.username, 'paula');
	assert.strictEqual(created[1].comments.length, 0);
	assert.strictEqual(prisma.replacements.every((row) => row.created_by_id === PAULA.id), true);
});

test('createReplacements rejects a SKU that is not in the catalog and names it', async () => {
	const service = makeService(makePrismaStub({ products: PRODUCTS }));
	await rejectsWith(
		service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'NOPE-1' }] }),
		'SKU_NOT_FOUND',
		400
	);
	await assert.rejects(
		service.createReplacements({ user: PAULA, source_sku: 'NOPE-2', replacements: [{ replacement_sku: 'MOO-RK620185' }] }),
		(error) => error.code === 'SKU_NOT_FOUND' && /NOPE-2/.test(error.message)
	);
});

test('createReplacements rejects a self replacement (BR-06)', async () => {
	const service = makeService(makePrismaStub({ products: PRODUCTS }));
	await rejectsWith(
		service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'cro-83503077' }] }),
		'SELF_REPLACEMENT',
		409
	);
});

test('createReplacements rejects an active duplicate (BR-07), including one raised by the database', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });

	await rejectsWith(
		service.createReplacements({ user: TESS, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] }),
		'DUPLICATE_REPLACEMENT',
		409
	);
	// Same pair twice in one batch is also a duplicate.
	await rejectsWith(
		service.createReplacements({ user: TESS, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'OMX-18282.05' }, { replacement_sku: 'OMX-18282.05' }] }),
		'DUPLICATE_REPLACEMENT',
		409
	);
	// Race: the pre-check passes but the partial unique index fires on insert.
	const original = prisma.productReplacement.findMany;
	prisma.productReplacement.findMany = async () => [];
	await rejectsWith(
		service.createReplacements({ user: TESS, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] }),
		'DUPLICATE_REPLACEMENT',
		409
	);
	prisma.productReplacement.findMany = original;
	assert.strictEqual(prisma.replacements.length, 1);
});

test('createReplacements validates the batch shape', async () => {
	const service = makeService(makePrismaStub({ products: PRODUCTS }));
	await rejectsWith(service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [] }), 'VALIDATION', 400);
	await rejectsWith(service.createReplacements({ user: PAULA, source_sku: '', replacements: [{ replacement_sku: 'MOO-RK620185' }] }), 'VALIDATION', 400);
	await rejectsWith(
		service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185', comment: 'x'.repeat(2001) }] }),
		'VALIDATION',
		400
	);
});

test('a removed pair can be registered again', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const [first] = await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	await service.removeReplacement({ user: PAULA, id: first.id });
	const [second] = await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	assert.notStrictEqual(second.id, first.id);
});

test('getReplacementsForSku looks both ways and follows the links: registered, reverse and linked parts', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({
		user: PAULA,
		source_sku: 'CRO-83503077',
		replacements: [{ replacement_sku: 'MOO-RK620185', comment: 'Customer approval is required.' }, { replacement_sku: 'OMX-18282.05' }],
	});
	// A pair registered the other way round is the same link, listed once.
	await service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', replacements: [{ replacement_sku: 'CRO-83503077' }] });

	const result = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	assert.strictEqual(result.source_sku, 'CRO-83503077');
	assert.strictEqual(result.sourceProduct.name, 'Crown Front Lower Control Arm JK');
	assert.deepStrictEqual(result.replacements.map((row) => row.replacement_sku), ['MOO-RK620185', 'OMX-18282.05']);
	assert.deepStrictEqual(result.replacements.map((row) => row.relation), ['registered', 'registered']);
	assert.strictEqual(result.replacements[0].product.vendorProducts[0].vendor.name, 'Meyer');
	assert.strictEqual(result.replacements[0].comments[0].author.firstname, 'Paula');
	assert.strictEqual(result.replacements[0].createdBy.username, 'paula');

	// Looking at the replacement shows the original (reverse) and its other
	// replacements (linked through the original), with the row that links them.
	const fromMoo = await service.getReplacementsForSku({ sku: 'MOO-RK620185' });
	assert.deepStrictEqual(fromMoo.replacements.map((row) => [row.replacement_sku, row.relation, row.via]), [
		['CRO-83503077', 'reverse', 'MOO-RK620185'],
		['OMX-18282.05', 'linked', 'CRO-83503077'],
	]);
	assert.deepStrictEqual(fromMoo.replacements[0].registered_as, { source_sku: 'CRO-83503077', replacement_sku: 'MOO-RK620185' });
	assert.strictEqual(fromMoo.replacements[0].source_sku, 'MOO-RK620185', 'the row is presented as root -> part');
	assert.strictEqual(fromMoo.truncated, false);
	assert.strictEqual(fromMoo.replacements[0].product.name, 'Crown Front Lower Control Arm JK');
	assert.strictEqual(fromMoo.replacements[0].comments[0].body, 'Customer approval is required.');
	assert.strictEqual(fromMoo.replacements[0].createdBy.username, 'paula');

	const fromOmx = await service.getReplacementsForSku({ sku: 'OMX-18282.05' });
	assert.deepStrictEqual(fromOmx.replacements.map((row) => [row.replacement_sku, row.relation]), [
		['CRO-83503077', 'registered'],
		['MOO-RK620185', 'linked'],
	]);
});

test('the lookup stops following links after a few hops', async () => {
	const chain = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7'].map((sku) => ({ sku, name: sku, image: null, url_path: null, price: 1, status: 1, vendorProducts: [], competitorProducts: [] }));
	const prisma = makePrismaStub({ products: [...PRODUCTS, ...chain] });
	const service = makeService(prisma);
	for (let i = 0; i < chain.length - 1; i += 1) {
		await service.createReplacements({ user: PAULA, source_sku: chain[i].sku, replacements: [{ replacement_sku: chain[i + 1].sku }] });
	}
	const result = await service.getReplacementsForSku({ sku: 'A-1' });
	assert.deepStrictEqual(result.replacements.map((row) => row.replacement_sku), ['A-2', 'A-3', 'A-4', 'A-5']);
	assert.strictEqual(result.truncated, true, 'A-6 and A-7 exist beyond the hop limit');
	assert.strictEqual((await service.getReplacementsForSku({ sku: 'A-7' })).truncated, true);
	assert.strictEqual((await service.getReplacementsForSku({ sku: 'A-4' })).truncated, false, 'everything within reach');
});

test('a simple pair costs two queries on lookup and nothing is re-fetched', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	prisma.replacementFindManyCalls.length = 0;
	await service.getReplacementsForSku({ sku: 'MOO-RK620185' });
	assert.strictEqual(prisma.replacementFindManyCalls.length, 2);
	prisma.replacementFindManyCalls.length = 0;
	await service.countActiveBySkus({ skus: ['CRO-83503077', 'MOO-RK620185', 'RUG-11540.11'] });
	assert.strictEqual(prisma.replacementFindManyCalls.length, 1, 'both ends of the pair are roots: nothing new to follow');
});

test('a "no replacement" marker wins over links coming from other products', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'OMX-18282.05', no_replacement: true, comment: 'Not made anymore.' });
	await service.createReplacements({ user: TESS, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'OMX-18282.05' }] });

	const lookup = await service.getReplacementsForSku({ sku: 'OMX-18282.05' });
	assert.deepStrictEqual(lookup.replacements, []);
	assert.strictEqual(lookup.noReplacement.comment, 'Not made anymore.');
	const counts = await service.countActiveBySkus({ skus: ['OMX-18282.05', 'CRO-83503077'] });
	assert.deepStrictEqual(counts['OMX-18282.05'], { replacements: 0, noReplacement: { comment: 'Not made anymore.', by: 'Paula P', at: counts['OMX-18282.05'].noReplacement.at } });
	assert.deepStrictEqual(counts['CRO-83503077'], { replacements: 1, noReplacement: null });
});

test('getReplacementsForSku keeps the association when the replacement product left the catalog', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'OMX-18282.05' }] });
	PRODUCTS.splice(2, 1);
	try {
		const result = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
		assert.strictEqual(result.replacements.length, 1);
		assert.strictEqual(result.replacements[0].product, null);
	} finally {
		PRODUCTS.push({ sku: 'OMX-18282.05', name: 'Omix-ADA Front Lower Control Arm JK', image: 'img-omx', url_path: null, price: 150, status: 1, vendorProducts: [], competitorProducts: [] });
	}
});

test('countActiveBySkus counts the equivalents of each SKU, whichever side it was registered on', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const created = await service.createReplacements({
		user: PAULA,
		source_sku: 'CRO-83503077',
		replacements: [{ replacement_sku: 'MOO-RK620185' }, { replacement_sku: 'OMX-18282.05' }],
	});
	assert.deepStrictEqual(
		await service.countActiveBySkus({ skus: ['CRO-83503077', 'MOO-RK620185', ' CRO-83503077 '] }),
		{ 'CRO-83503077': { replacements: 2, noReplacement: null }, 'MOO-RK620185': { replacements: 2, noReplacement: null } }
	);
	await service.removeReplacement({ user: PAULA, id: created[0].id });
	assert.deepStrictEqual(await service.countActiveBySkus({ skus: ['CRO-83503077'] }), { 'CRO-83503077': { replacements: 1, noReplacement: null } });
	assert.deepStrictEqual(await service.countActiveBySkus({ skus: [] }), {});
	await rejectsWith(service.countActiveBySkus({ skus: Array.from({ length: 201 }, (_, i) => `X-${i}`) }), 'VALIDATION', 400);
});

test('removeReplacement is allowed for the creator and managers, and hides the pair everywhere', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const [row] = await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });

	await rejectsWith(service.removeReplacement({ user: TESS, id: row.id }), 'NOT_ALLOWED', 409);
	await service.removeReplacement({ user: RICARDO, id: row.id });
	assert.strictEqual(prisma.replacements[0].deletedById, RICARDO.id);
	assert.ok(prisma.replacements[0].deletedAt instanceof Date);

	assert.deepStrictEqual((await service.getReplacementsForSku({ sku: 'CRO-83503077' })).replacements, []);
	assert.deepStrictEqual(await service.countActiveBySkus({ skus: ['CRO-83503077'] }), {});
	await rejectsWith(service.removeReplacement({ user: RICARDO, id: row.id }), 'REPLACEMENT_NOT_FOUND', 404);
	await rejectsWith(service.removeReplacement({ user: RICARDO, id: 999 }), 'REPLACEMENT_NOT_FOUND', 404);
});

test('comments carry their author and can be removed by the author or a manager', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const [row] = await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });

	const comment = await service.addComment({ user: TESS, id: row.id, body: '  Same product, different manufacturer. ' });
	assert.strictEqual(comment.body, 'Same product, different manufacturer.');
	assert.strictEqual(comment.author.username, 'tess');
	await rejectsWith(service.addComment({ user: TESS, id: row.id, body: '   ' }), 'VALIDATION', 400);
	await rejectsWith(service.addComment({ user: TESS, id: 999, body: 'x' }), 'REPLACEMENT_NOT_FOUND', 404);

	await rejectsWith(service.removeComment({ user: PAULA, id: row.id, commentId: comment.id }), 'NOT_ALLOWED', 409);
	await service.removeComment({ user: TESS, id: row.id, commentId: comment.id });
	const lookup = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	assert.deepStrictEqual(lookup.replacements[0].comments, []);
	await rejectsWith(service.removeComment({ user: RICARDO, id: row.id, commentId: comment.id }), 'COMMENT_NOT_FOUND', 404);
});

test('listReplacements groups by original product and searches SKUs and product names', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }, { replacement_sku: 'OMX-18282.05' }] });
	await service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', replacements: [{ replacement_sku: 'MOO-RK620185' }] });

	const all = await service.listReplacements({});
	assert.strictEqual(all.total, 3);
	assert.deepStrictEqual(all.groups.map((group) => group.source_sku), ['OMX-18282.05', 'CRO-83503077']);
	assert.strictEqual(all.groups[1].sourceProduct.image, 'img-cro');
	assert.strictEqual(all.groups[1].replacements[0].product.name, 'Moog Front Lower Control Arm JK');

	const bySku = await service.listReplacements({ search: 'omx' });
	assert.strictEqual(bySku.total, 2);
	const byName = await service.listReplacements({ search: 'crown' });
	assert.deepStrictEqual(byName.groups.map((group) => group.source_sku), ['CRO-83503077']);
	const nothing = await service.listReplacements({ search: 'zzz' });
	assert.strictEqual(nothing.total, 0);
});

// --- Live product info from Magento --------------------------------------------

const makeMagentoStub = (products, { degraded = false, configured = true } = {}) => {
	const calls = [];
	return {
		calls,
		isConfigured: () => configured,
		getProductsBySkus: async (skus) => {
			calls.push([...skus]);
			return {
				products: new Map(skus.filter((sku) => products[sku]).map((sku) => [sku, products[sku]])),
				degraded,
			};
		},
	};
};

const MAGENTO = {
	'CRO-83503077': { sku: 'CRO-83503077', name: 'Crown (live name)', description: 'Live description of the Crown arm', image: 'https://www.justjeeps.com/pub/media/catalog/product/live-cro.jpg', url_path: 'https://www.justjeeps.com/live-cro.html' },
	'MOO-RK620185': { sku: 'MOO-RK620185', name: 'Moog (live name)', description: 'Live description of the Moog arm', image: 'https://www.justjeeps.com/pub/media/catalog/product/live-moo.jpg', url_path: 'https://www.justjeeps.com/live-moo.html' },
};

function makeServiceWithMagento(prisma, magento) {
	return createProductReplacementsService({
		prisma,
		isManager: (username) => CONFIG.managers.includes(username),
		config: CONFIG,
		magento,
	});
}

test('product cards use the live Magento name, image, description and page, keeping the catalog price', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const magento = makeMagentoStub(MAGENTO);
	const service = makeServiceWithMagento(prisma, magento);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });

	const list = await service.listReplacements({});
	const source = list.groups[0].sourceProduct;
	assert.strictEqual(source.name, 'Crown (live name)');
	assert.strictEqual(source.description, 'Live description of the Crown arm');
	assert.strictEqual(source.image, 'https://www.justjeeps.com/pub/media/catalog/product/live-cro.jpg');
	assert.strictEqual(source.url_path, 'https://www.justjeeps.com/live-cro.html');
	assert.strictEqual(source.price, 199.95, 'price still comes from the catalog table');
	assert.strictEqual(source.source, 'magento');
	assert.deepStrictEqual(magento.calls[magento.calls.length - 1].sort(), ['CRO-83503077', 'MOO-RK620185']);

	const lookup = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	assert.strictEqual(lookup.replacements[0].product.name, 'Moog (live name)');
	assert.strictEqual(lookup.replacements[0].product.description, 'Live description of the Moog arm');
	assert.strictEqual(lookup.replacements[0].product.vendorProducts[0].vendor.name, 'Meyer', 'vendor data still from the catalog');
});

test('when Magento does not know a SKU the catalog data is used, and a SKU in neither is null', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeServiceWithMagento(prisma, makeMagentoStub(MAGENTO));
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'OMX-18282.05' }] });
	const lookup = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	const omix = lookup.replacements[0].product;
	assert.strictEqual(omix.name, 'Omix-ADA Front Lower Control Arm JK');
	assert.strictEqual(omix.description, null);
	assert.strictEqual(omix.source, 'catalog');
});

test('a SKU only known by Magento gets a preview card, but never a lookup product (ProductTable needs catalog data)', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const magento = makeMagentoStub({ ...MAGENTO, 'NEW-1': { sku: 'NEW-1', name: 'Brand new part', description: 'Just listed', image: null, url_path: null } });
	const service = makeServiceWithMagento(prisma, magento);
	const product = await service.getProductBySku({ sku: 'NEW-1' });
	assert.strictEqual(product.name, 'Brand new part');
	assert.strictEqual(product.source, 'magento');
	assert.strictEqual(await service.getProductBySku({ sku: 'NOPE' }), null);

	// The pair was registered while NEW-1 was in the catalog; then the seeds dropped it.
	prisma.replacements.push({ id: 900, source_sku: 'CRO-83503077', replacement_sku: 'NEW-1', created_by_id: 1, createdAt: new Date(), deletedAt: null, deletedById: null });
	const lookup = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	assert.strictEqual(lookup.replacements[0].replacement_sku, 'NEW-1');
	assert.strictEqual(lookup.replacements[0].product, null, 'no catalog row = no product for the drawer');
	const list = await service.listReplacements({});
	assert.strictEqual(list.groups[0].replacements[0].product, null);
});

test('responses say whether Magento answered, so the UI can tell the user the cards are catalog data', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	await makeService(prisma).createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });

	const live = makeServiceWithMagento(prisma, makeMagentoStub(MAGENTO));
	assert.deepStrictEqual((await live.listReplacements({})).magento, { configured: true, degraded: false });
	assert.deepStrictEqual((await live.getReplacementsForSku({ sku: 'CRO-83503077' })).magento, { configured: true, degraded: false });

	const down = makeServiceWithMagento(prisma, makeMagentoStub({}, { degraded: true }));
	const list = await down.listReplacements({});
	assert.deepStrictEqual(list.magento, { configured: true, degraded: true });
	assert.strictEqual(list.groups[0].sourceProduct.source, 'catalog');

	const unset = makeServiceWithMagento(prisma, makeMagentoStub({}, { configured: false, degraded: true }));
	assert.deepStrictEqual((await unset.listReplacements({})).magento, { configured: false, degraded: true });
	assert.deepStrictEqual((await makeService(prisma).listReplacements({})).magento, { configured: false, degraded: true });
});

test('directory search matches the live Magento name shown on the card and is not capped by a catalog pre-query', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeServiceWithMagento(prisma, makeMagentoStub(MAGENTO));
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }, { replacement_sku: 'OMX-18282.05' }] });
	// "live name" only exists in the Magento names, not in the catalog names.
	const byLiveName = await service.listReplacements({ search: 'live name' });
	assert.strictEqual(byLiveName.total, 2);
	// A term that only the catalog name of OMX has still matches (OMX has no Magento data here).
	const byCatalogName = await service.listReplacements({ search: 'omix-ada' });
	assert.strictEqual(byCatalogName.total, 1);
	assert.strictEqual(prisma.productFindManyCalls.filter((call) => call.where && call.where.name).length, 0, 'no name pre-query against the whole catalog');
});

test('total counts every active association even when the list is capped', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = createProductReplacementsService({ prisma, isManager: () => false, config: { ...CONFIG, listMax: 1 } });
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }, { replacement_sku: 'OMX-18282.05' }] });
	const list = await service.listReplacements({});
	assert.strictEqual(list.total, 2);
	assert.strictEqual(list.groups.reduce((sum, group) => sum + group.replacements.length, 0), 1);
	assert.strictEqual(list.truncated, true);
});

test('a batch is all or nothing: a P2002 on the second row leaves nothing behind', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	const original = prisma.productReplacement.findMany;
	prisma.productReplacement.findMany = async () => [];
	await rejectsWith(
		service.createReplacements({ user: TESS, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'OMX-18282.05' }, { replacement_sku: 'MOO-RK620185' }] }),
		'DUPLICATE_REPLACEMENT',
		409
	);
	prisma.productReplacement.findMany = original;
	assert.strictEqual(prisma.replacements.length, 1, 'the first row of the failed batch must be rolled back');
});

test('getProductBySku merges the catalog and Magento for the modal preview', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeServiceWithMagento(prisma, makeMagentoStub(MAGENTO));
	const product = await service.getProductBySku({ sku: ' MOO-RK620185 ' });
	assert.strictEqual(product.sku, 'MOO-RK620185');
	assert.strictEqual(product.name, 'Moog (live name)');
	assert.strictEqual(product.price, 189.95);
	assert.strictEqual(product.brand_name, undefined, 'summary select only');
});

test('without a Magento client everything comes from the catalog', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const product = await service.getProductBySku({ sku: 'CRO-83503077' });
	assert.strictEqual(product.name, 'Crown Front Lower Control Arm JK');
	assert.strictEqual(product.source, 'catalog');
});

// --- "No replacement" marker ---------------------------------------------------

test('marking a product as having no replacement stores one marker row with its required comment', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const created = await service.createReplacements({
		user: PAULA,
		source_sku: ' CRO-83503077 ',
		no_replacement: true,
		comment: ' Discontinued by the manufacturer, no equivalent part. ',
	});
	assert.strictEqual(created.length, 1);
	assert.strictEqual(created[0].kind, 'none');
	assert.strictEqual(created[0].replacement_sku, null);
	assert.strictEqual(created[0].source_sku, 'CRO-83503077');
	assert.strictEqual(created[0].comments[0].body, 'Discontinued by the manufacturer, no equivalent part.');
	assert.strictEqual(created[0].comments[0].author.username, 'paula');

	await rejectsWith(service.createReplacements({ user: PAULA, source_sku: 'MOO-RK620185', no_replacement: true, comment: '   ' }), 'COMMENT_REQUIRED', 400);
	await rejectsWith(service.createReplacements({ user: PAULA, source_sku: 'MOO-RK620185', no_replacement: true, comment: 'x', replacements: [{ replacement_sku: 'OMX-18282.05' }] }), 'VALIDATION', 400);
	await rejectsWith(service.createReplacements({ user: PAULA, source_sku: 'NOPE', no_replacement: true, comment: 'x' }), 'SKU_NOT_FOUND', 400);
});

test('a marker and replacements never coexist: each side is blocked with its own code', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	await rejectsWith(service.createReplacements({ user: TESS, source_sku: 'CRO-83503077', no_replacement: true, comment: 'none' }), 'HAS_REPLACEMENTS', 409);

	await service.createReplacements({ user: PAULA, source_sku: 'OMX-18282.05', no_replacement: true, comment: 'Not made anymore.' });
	await rejectsWith(service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', replacements: [{ replacement_sku: 'MOO-RK620185' }] }), 'MARKED_NO_REPLACEMENT', 409);
	await rejectsWith(service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', no_replacement: true, comment: 'again' }), 'NO_REPLACEMENT_EXISTS', 409);

	// Race on the partial unique index of the marker.
	const original = prisma.productReplacement.findMany;
	prisma.productReplacement.findMany = async () => [];
	await rejectsWith(service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', no_replacement: true, comment: 'again' }), 'NO_REPLACEMENT_EXISTS', 409);
	prisma.productReplacement.findMany = original;

	// Removing the marker frees the product again.
	const marker = prisma.replacements.find((row) => row.kind === 'none');
	await service.removeReplacement({ user: PAULA, id: marker.id });
	const [pair] = await service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	assert.strictEqual(pair.kind, 'replacement');
});

test('the lookup never offers a marker as an option and reports it separately', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'OMX-18282.05', no_replacement: true, comment: 'Not made anymore.' });
	const lookup = await service.getReplacementsForSku({ sku: 'OMX-18282.05' });
	assert.deepStrictEqual(lookup.replacements, []);
	assert.strictEqual(lookup.noReplacement.comment, 'Not made anymore.');
	assert.strictEqual(lookup.noReplacement.createdBy.username, 'paula');
	assert.ok(lookup.noReplacement.createdAt instanceof Date);
	assert.ok(Number.isInteger(lookup.noReplacement.id));

	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }] });
	const pairs = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	assert.strictEqual(pairs.replacements.length, 1);
	assert.strictEqual(pairs.noReplacement, null);
});

test('counts tell the Orders screen how many replacements a SKU has or that it has none, with the tooltip text', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: PAULA, source_sku: 'CRO-83503077', replacements: [{ replacement_sku: 'MOO-RK620185' }, { replacement_sku: 'OMX-18282.05' }] });
	await service.createReplacements({ user: TESS, source_sku: 'RUG-11540.11', no_replacement: true, comment: 'Kit discontinued, no equivalent.' });
	const counts = await service.countActiveBySkus({ skus: ['CRO-83503077', 'RUG-11540.11', 'MOO-RK620185', 'UNKNOWN-1'] });
	assert.deepStrictEqual(counts['CRO-83503077'], { replacements: 2, noReplacement: null });
	assert.strictEqual(counts['RUG-11540.11'].replacements, 0);
	assert.strictEqual(counts['RUG-11540.11'].noReplacement.comment, 'Kit discontinued, no equivalent.');
	assert.strictEqual(counts['RUG-11540.11'].noReplacement.by, 'Tess T');
	assert.ok(counts['RUG-11540.11'].noReplacement.at instanceof Date);
	assert.deepStrictEqual(counts['MOO-RK620185'], { replacements: 2, noReplacement: null }, 'registered as a replacement: sees the original and its other replacement');
	assert.strictEqual(counts['UNKNOWN-1'], undefined, 'nothing registered = no key');
});

test('the directory lists a marker as a row without a replacement product and finds it by "no replacement"', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({ user: TESS, source_sku: 'RUG-11540.11', no_replacement: true, comment: 'Kit discontinued.' });
	const list = await service.listReplacements({});
	const row = list.groups[0].replacements[0];
	assert.strictEqual(row.kind, 'none');
	assert.strictEqual(row.replacement_sku, null);
	assert.strictEqual(row.product, null);
	assert.strictEqual(list.groups[0].sourceProduct.sku, 'RUG-11540.11');
	assert.strictEqual((await service.listReplacements({ search: 'no replacement' })).total, 1);
	assert.strictEqual((await service.listReplacements({ search: 'rugged' })).total, 1);
});
