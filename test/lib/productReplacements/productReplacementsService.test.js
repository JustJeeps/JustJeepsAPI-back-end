const test = require('node:test');
const assert = require('node:assert');

const { createProductReplacementsService } = require('../../../services/productReplacements/productReplacementsService');
const { ProductReplacementError } = require('../../../services/productReplacements/errors');

// In-memory prisma stub covering ONLY the query shapes the service uses
// (same approach as test/lib/reviews/reviewServices.test.js). No database.
function makePrismaStub({ products = [] } = {}) {
	const replacements = [];
	const comments = [];
	const users = new Map([
		[1, { id: 1, username: 'paula', email: 'paula@x', firstname: 'Paula', lastname: 'P' }],
		[2, { id: 2, username: 'tess', email: 'tess@x', firstname: 'Tess', lastname: 'T' }],
		[3, { id: 3, username: 'ricardo', email: 'ricardo@x', firstname: 'Ricardo', lastname: 'R' }],
	]);
	let nextId = 1;

	const pick = (row, select) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
	const userFor = (id, select) => (select ? pick(users.get(id), select) : users.get(id));

	const matchesStringFilter = (value, filter) => {
		if (filter === undefined) return true;
		if (typeof filter === 'string') return value === filter;
		if (filter.in) return filter.in.includes(value);
		if (filter.contains !== undefined) {
			const haystack = filter.mode === 'insensitive' ? String(value || '').toLowerCase() : String(value || '');
			const needle = filter.mode === 'insensitive' ? filter.contains.toLowerCase() : filter.contains;
			return haystack.includes(needle);
		}
		return true;
	};

	const matchesReplacement = (row, where = {}) => {
		if (where.id !== undefined && row.id !== where.id) return false;
		if (where.deletedAt === null && row.deletedAt !== null) return false;
		if (!matchesStringFilter(row.source_sku, where.source_sku)) return false;
		if (!matchesStringFilter(row.replacement_sku, where.replacement_sku)) return false;
		if (where.OR && !where.OR.some((clause) => matchesReplacement(row, clause))) return false;
		return true;
	};

	const commentsOf = (replacementId, args = {}) => {
		let found = comments.filter((comment) => comment.replacement_id === replacementId);
		if (args.where?.deletedAt === null) found = found.filter((comment) => comment.deletedAt === null);
		found = found.sort((a, b) => a.id - b.id);
		return found.map((comment) => hydrateComment(comment, args.include));
	};

	const hydrateComment = (comment, include) => ({
		...comment,
		...(include?.author ? { author: userFor(comment.author_id, include.author.select) } : {}),
	});

	const hydrateReplacement = (row, include) => ({
		...row,
		...(include?.createdBy ? { createdBy: userFor(row.created_by_id, include.createdBy.select) } : {}),
		...(include?.comments ? { comments: commentsOf(row.id, include.comments === true ? {} : include.comments) } : {}),
	});

	const stub = {
		replacements,
		comments,
		productFindManyCalls: [],
		product: {
			findMany: async ({ where = {}, select, take } = {}) => {
				stub.productFindManyCalls.push({ where, select, take });
				let found = products.filter((product) =>
					matchesStringFilter(product.sku, where.sku) && matchesStringFilter(product.name, where.name));
				if (take) found = found.slice(0, take);
				return select ? found.map((product) => pick(product, select)) : found.map((product) => ({ ...product }));
			},
		},
		productReplacement: {
			findMany: async ({ where, include, orderBy, take } = {}) => {
				let found = replacements.filter((row) => matchesReplacement(row, where));
				if (orderBy?.createdAt === 'desc') found = [...found].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
				if (take) found = found.slice(0, take);
				return found.map((row) => hydrateReplacement(row, include));
			},
			findFirst: async ({ where, include } = {}) => {
				const row = replacements.find((entry) => matchesReplacement(entry, where));
				return row ? hydrateReplacement(row, include) : null;
			},
			create: async ({ data, include }) => {
				const duplicate = replacements.some((row) =>
					row.deletedAt === null && row.source_sku === data.source_sku && row.replacement_sku === data.replacement_sku);
				if (duplicate) {
					const error = new Error('Unique constraint failed');
					error.code = 'P2002';
					throw error;
				}
				const row = {
					id: nextId++,
					source_sku: data.source_sku,
					replacement_sku: data.replacement_sku,
					created_by_id: data.created_by_id,
					createdAt: new Date(),
					deletedAt: null,
					deletedById: null,
				};
				replacements.push(row);
				for (const entry of data.comments?.create || []) {
					comments.push({ id: nextId++, replacement_id: row.id, deletedAt: null, deletedById: null, createdAt: new Date(), ...entry });
				}
				return hydrateReplacement(row, include);
			},
			update: async ({ where, data }) => {
				const row = replacements.find((entry) => entry.id === where.id);
				Object.assign(row, data);
				return { ...row };
			},
			count: async ({ where } = {}) => replacements.filter((row) => matchesReplacement(row, where)).length,
			groupBy: async ({ where }) => {
				const counts = new Map();
				for (const row of replacements) {
					if (!matchesReplacement(row, where)) continue;
					counts.set(row.source_sku, (counts.get(row.source_sku) || 0) + 1);
				}
				return [...counts.entries()].map(([source_sku, count]) => ({ source_sku, _count: { _all: count } }));
			},
		},
		productReplacementComment: {
			create: async ({ data, include }) => {
				const comment = { id: nextId++, deletedAt: null, deletedById: null, createdAt: new Date(), ...data };
				comments.push(comment);
				return hydrateComment(comment, include);
			},
			findFirst: async ({ where } = {}) => {
				const comment = comments.find((entry) =>
					entry.id === where.id && (where.replacement_id === undefined || entry.replacement_id === where.replacement_id)
					&& (where.deletedAt !== null || entry.deletedAt === null));
				return comment ? { ...comment } : null;
			},
			update: async ({ where, data }) => {
				const comment = comments.find((entry) => entry.id === where.id);
				Object.assign(comment, data);
				return { ...comment };
			},
		},
		$transaction: async (fn) => {
			// Real Prisma rolls the whole callback back on a throw; mirror that.
			const snapshot = { replacements: replacements.length, comments: comments.length };
			try {
				return await fn(stub);
			} catch (error) {
				replacements.length = snapshot.replacements;
				comments.length = snapshot.comments;
				throw error;
			}
		},
	};
	return stub;
}

const PRODUCTS = [
	{ sku: 'CRO-83503077', name: 'Crown Front Lower Control Arm JK', image: 'img-cro', url_path: 'https://www.justjeeps.com/cro.html', price: 199.95, status: 1, vendorProducts: [], competitorProducts: [] },
	{ sku: 'MOO-RK620185', name: 'Moog Front Lower Control Arm JK', image: 'img-moo', url_path: 'https://www.justjeeps.com/moo.html', price: 189.95, status: 1, vendorProducts: [{ vendor_cost: 118.4, vendor: { name: 'Meyer' } }], competitorProducts: [] },
	{ sku: 'OMX-18282.05', name: 'Omix-ADA Front Lower Control Arm JK', image: 'img-omx', url_path: null, price: 150, status: 1, vendorProducts: [], competitorProducts: [] },
];

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

test('getReplacementsForSku returns active replacements of that source only, with lookup data and comments', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	await service.createReplacements({
		user: PAULA,
		source_sku: 'CRO-83503077',
		replacements: [{ replacement_sku: 'MOO-RK620185', comment: 'Customer approval is required.' }, { replacement_sku: 'OMX-18282.05' }],
	});
	// Reverse direction is a different association (BR-08) and must not show up.
	await service.createReplacements({ user: TESS, source_sku: 'OMX-18282.05', replacements: [{ replacement_sku: 'CRO-83503077' }] });

	const result = await service.getReplacementsForSku({ sku: 'CRO-83503077' });
	assert.strictEqual(result.source_sku, 'CRO-83503077');
	assert.strictEqual(result.sourceProduct.name, 'Crown Front Lower Control Arm JK');
	assert.deepStrictEqual(result.replacements.map((row) => row.replacement_sku), ['MOO-RK620185', 'OMX-18282.05']);
	assert.strictEqual(result.replacements[0].product.vendorProducts[0].vendor.name, 'Meyer');
	assert.strictEqual(result.replacements[0].comments[0].author.firstname, 'Paula');
	assert.strictEqual(result.replacements[0].createdBy.username, 'paula');

	const reverse = await service.getReplacementsForSku({ sku: 'OMX-18282.05' });
	assert.deepStrictEqual(reverse.replacements.map((row) => row.replacement_sku), ['CRO-83503077']);

	const none = await service.getReplacementsForSku({ sku: 'MOO-RK620185' });
	assert.deepStrictEqual(none.replacements, []);
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

test('countActiveBySkus counts active associations per source SKU', async () => {
	const prisma = makePrismaStub({ products: PRODUCTS });
	const service = makeService(prisma);
	const created = await service.createReplacements({
		user: PAULA,
		source_sku: 'CRO-83503077',
		replacements: [{ replacement_sku: 'MOO-RK620185' }, { replacement_sku: 'OMX-18282.05' }],
	});
	assert.deepStrictEqual(await service.countActiveBySkus({ skus: ['CRO-83503077', 'MOO-RK620185', ' CRO-83503077 '] }), { 'CRO-83503077': 2 });
	await service.removeReplacement({ user: PAULA, id: created[0].id });
	assert.deepStrictEqual(await service.countActiveBySkus({ skus: ['CRO-83503077'] }), { 'CRO-83503077': 1 });
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
