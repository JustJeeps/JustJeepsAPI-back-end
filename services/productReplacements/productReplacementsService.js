// Use cases of the Product Replacement feature (docs/PRODUCT-REPLACEMENTS.md).
// Single data-access layer: thin route -> this service -> pure rules in
// lib/productReplacements. Dependencies are injected so the tests run without
// a database (test/lib/productReplacements/productReplacementsService.test.js).
//
// Associations carry SKU strings and NOT a foreign key to Product: the catalog
// is rewritten by the seeds and prisma/seeds/deleteEntries.js drops products
// by prefix, so the directory must survive catalog churn. SKUs are validated
// against Product when created and the product is resolved at read time.
//
// Product cards (name, image, description, store page) come from the live
// Magento API through the injected `magento` client (lib/magento/
// productInfoClient.js) and fall back to the Product table when Magento does
// not answer or does not know the SKU. Price, vendor costs, competitors and
// inventory always come from the catalog table.

const {
	normalizeSku,
	isSelfReplacement,
	canRemoveReplacement,
	canRemoveComment,
	groupBySourceSku,
} = require('../../lib/productReplacements/rules');
const { PRODUCT_LOOKUP_SELECT } = require('../../lib/products/productLookupSelect');
const { ProductReplacementError } = require('./errors');

const USER_SELECT = { id: true, username: true, email: true, firstname: true, lastname: true };

// Directory and management screens only need the product card.
const PRODUCT_SUMMARY_SELECT = { sku: true, name: true, image: true, url_path: true, price: true, brand_name: true, status: true };

const COMMENTS_INCLUDE = {
	where: { deletedAt: null },
	include: { author: { select: USER_SELECT } },
	orderBy: { createdAt: 'asc' },
};

const REPLACEMENT_INCLUDE = {
	createdBy: { select: USER_SELECT },
	comments: COMMENTS_INCLUDE,
};

const isUniqueViolation = (error) => error && error.code === 'P2002';

function createProductReplacementsService({ prisma, config, isManager, magento = null, now = () => new Date() } = {}) {
	const managerOf = (user) => isManager(user && user.username);

	// --- validation helpers ----------------------------------------------------

	const requireSku = (value, label) => {
		const sku = normalizeSku(value);
		if (!sku) throw ProductReplacementError.validation(`${label} is required`);
		if (sku.length > config.skuMaxLength) {
			throw ProductReplacementError.validation(`${label} is too long (max ${config.skuMaxLength} chars)`);
		}
		return sku;
	};

	const optionalComment = (value) => {
		const body = String(value ?? '').trim();
		if (!body) return null;
		if (body.length > config.commentMaxLength) {
			throw ProductReplacementError.validation(`Comment is too long (max ${config.commentMaxLength} chars)`);
		}
		return body;
	};

	const requireComment = (value) => {
		const body = optionalComment(value);
		if (!body) throw ProductReplacementError.validation('Comment is required');
		return body;
	};

	// --- product resolution ----------------------------------------------------

	// Catalog table only (validation of new associations).
	const catalogProductsBySku = async (skus, select) => {
		const unique = [...new Set(skus.filter(Boolean))];
		if (unique.length === 0) return new Map();
		const products = await prisma.product.findMany({ where: { sku: { in: unique } }, select });
		return new Map(products.map((product) => [product.sku, product]));
	};

	// Catalog + live Magento info. `source` tells the UI where the card came
	// from. A SKU that Magento knows but the catalog does not only becomes a
	// card when `allowMagentoOnly` (modal preview): the lookup drawer renders
	// ProductTable, which needs the catalog's vendor and competitor arrays.
	// Returns { products: Map, magento: { configured, degraded } }.
	const productsBySku = async (skus, select, { allowMagentoOnly = false } = {}) => {
		const unique = [...new Set(skus.filter(Boolean))];
		const catalog = await catalogProductsBySku(unique, select);
		const configured = Boolean(magento && magento.isConfigured());
		const liveAnswer = configured ? await magento.getProductsBySkus(unique) : { products: new Map(), degraded: true };
		const live = liveAnswer.products;
		const merged = new Map();
		for (const sku of unique) {
			const fromCatalog = catalog.get(sku);
			const fromMagento = live.get(sku);
			if (!fromCatalog && !(fromMagento && allowMagentoOnly)) continue;
			if (!fromMagento) {
				merged.set(sku, { ...fromCatalog, description: null, source: 'catalog' });
				continue;
			}
			merged.set(sku, {
				...(fromCatalog || { sku }),
				name: fromMagento.name || fromCatalog?.name || null,
				image: fromMagento.image || fromCatalog?.image || null,
				url_path: fromMagento.url_path || fromCatalog?.url_path || null,
				description: fromMagento.description || null,
				source: 'magento',
			});
		}
		return { products: merged, magento: { configured, degraded: !configured || Boolean(liveAnswer.degraded) } };
	};

	const matchesSearch = (term, ...values) => values.some((value) => String(value || '').toLowerCase().includes(term));

	const attachProducts = (rows, products) => rows.map((row) => ({
		...row,
		product: products.get(row.replacement_sku) || null,
	}));

	// --- loaders ---------------------------------------------------------------

	const loadReplacementOrFail = async (id) => {
		const replacement = await prisma.productReplacement.findFirst({
			where: { id, deletedAt: null },
			include: REPLACEMENT_INCLUDE,
		});
		if (!replacement) throw ProductReplacementError.notFound('REPLACEMENT_NOT_FOUND', 'Replacement not found');
		return replacement;
	};

	// --- use cases -------------------------------------------------------------

	// Directory. The search runs in memory over the rows already loaded (capped
	// at listMax, newest first) and over the names shown on the cards, which
	// are the live Magento names when available: a catalog pre-query would
	// silently cap common terms ("control arm") at an arbitrary subset.
	async function listReplacements({ search } = {}) {
		const term = String(search ?? '').trim().toLowerCase();
		const where = { deletedAt: null };

		const [rows, activeCount] = await Promise.all([
			prisma.productReplacement.findMany({
				where,
				include: REPLACEMENT_INCLUDE,
				orderBy: { createdAt: 'desc' },
				take: config.listMax,
			}),
			prisma.productReplacement.count({ where }),
		]);

		const { products, magento: magentoStatus } = await productsBySku(
			rows.flatMap((row) => [row.source_sku, row.replacement_sku]),
			PRODUCT_SUMMARY_SELECT
		);

		const matching = term
			? rows.filter((row) => matchesSearch(
				term,
				row.source_sku,
				row.replacement_sku,
				products.get(row.source_sku)?.name,
				products.get(row.replacement_sku)?.name
			))
			: rows;

		// Newest original product first; inside a group, registration order.
		const groups = groupBySourceSku(matching).map((group) => ({
			source_sku: group.source_sku,
			sourceProduct: products.get(group.source_sku) || null,
			replacements: attachProducts(
				[...group.replacements].sort((a, b) => (a.createdAt - b.createdAt) || (a.id - b.id)),
				products
			),
		}));

		return {
			groups,
			total: term ? matching.length : activeCount,
			truncated: activeCount > rows.length,
			magento: magentoStatus,
		};
	}

	async function createReplacements({ user, source_sku, replacements }) {
		const sourceSku = requireSku(source_sku, 'Source SKU');
		if (!Array.isArray(replacements) || replacements.length === 0) {
			throw ProductReplacementError.validation('At least one replacement is required');
		}
		if (replacements.length > config.createMaxBatch) {
			throw ProductReplacementError.validation(`Too many replacements in one call (max ${config.createMaxBatch})`);
		}

		const entries = replacements.map((entry) => ({
			replacement_sku: requireSku(entry && entry.replacement_sku, 'Replacement SKU'),
			comment: optionalComment(entry && entry.comment),
		}));

		const seen = new Set();
		for (const entry of entries) {
			if (isSelfReplacement(sourceSku, entry.replacement_sku)) {
				throw ProductReplacementError.conflict('SELF_REPLACEMENT', `${sourceSku} cannot replace itself`);
			}
			if (seen.has(entry.replacement_sku)) {
				throw ProductReplacementError.conflict('DUPLICATE_REPLACEMENT', `${entry.replacement_sku} is listed twice`);
			}
			seen.add(entry.replacement_sku);
		}

		const replacementSkus = entries.map((entry) => entry.replacement_sku);
		const known = await catalogProductsBySku([sourceSku, ...replacementSkus], { sku: true });
		const missing = [sourceSku, ...replacementSkus].find((sku) => !known.has(sku));
		if (missing) {
			throw ProductReplacementError.validation(`SKU ${missing} was not found in the catalog`, 'SKU_NOT_FOUND');
		}

		const existing = await prisma.productReplacement.findMany({
			where: { source_sku: sourceSku, replacement_sku: { in: replacementSkus }, deletedAt: null },
		});
		if (existing.length > 0) {
			throw ProductReplacementError.conflict(
				'DUPLICATE_REPLACEMENT',
				`${existing[0].replacement_sku} is already registered as a replacement for ${sourceSku}`
			);
		}

		try {
			return await prisma.$transaction(async (tx) => {
				const created = [];
				for (const entry of entries) {
					created.push(await tx.productReplacement.create({
						data: {
							source_sku: sourceSku,
							replacement_sku: entry.replacement_sku,
							created_by_id: user.id,
							...(entry.comment ? { comments: { create: [{ author_id: user.id, body: entry.comment }] } } : {}),
						},
						include: REPLACEMENT_INCLUDE,
					}));
				}
				return created;
			});
		} catch (error) {
			// Partial unique index (source_sku, replacement_sku) WHERE deletedAt IS NULL:
			// two people registering the same pair at the same time.
			if (isUniqueViolation(error)) {
				throw ProductReplacementError.conflict('DUPLICATE_REPLACEMENT', `One of these replacements is already registered for ${sourceSku}`);
			}
			throw error;
		}
	}

	async function removeReplacement({ user, id }) {
		const replacement = await loadReplacementOrFail(id);
		if (!canRemoveReplacement({ replacement, user, isManager: managerOf(user) })) {
			throw ProductReplacementError.conflict('NOT_ALLOWED', 'Only the person who registered this replacement or a manager can remove it');
		}
		await prisma.productReplacement.update({
			where: { id },
			data: { deletedAt: now(), deletedById: user.id },
		});
		return { id, removed: true };
	}

	async function addComment({ user, id, body }) {
		await loadReplacementOrFail(id);
		const text = requireComment(body);
		return prisma.productReplacementComment.create({
			data: { replacement_id: id, author_id: user.id, body: text },
			include: { author: { select: USER_SELECT } },
		});
	}

	async function removeComment({ user, id, commentId }) {
		await loadReplacementOrFail(id);
		const comment = await prisma.productReplacementComment.findFirst({
			where: { id: commentId, replacement_id: id, deletedAt: null },
		});
		if (!comment) throw ProductReplacementError.notFound('COMMENT_NOT_FOUND', 'Comment not found');
		if (!canRemoveComment({ comment, user, isManager: managerOf(user) })) {
			throw ProductReplacementError.conflict('NOT_ALLOWED', 'Only the author of this comment or a manager can remove it');
		}
		await prisma.productReplacementComment.update({
			where: { id: commentId },
			data: { deletedAt: now(), deletedById: user.id },
		});
		return { id: commentId, removed: true };
	}

	// Orders screen: everything registered for this source SKU, each replacement
	// with the same projection the magnifier lookup uses. Direction is explicit
	// (BR-08): only rows whose source_sku is this SKU.
	async function getReplacementsForSku({ sku }) {
		const sourceSku = requireSku(sku, 'SKU');
		const rows = await prisma.productReplacement.findMany({
			where: { source_sku: sourceSku, deletedAt: null },
			include: REPLACEMENT_INCLUDE,
			orderBy: { createdAt: 'asc' },
		});
		const { products, magento: magentoStatus } = await productsBySku(
			[sourceSku, ...rows.map((row) => row.replacement_sku)],
			PRODUCT_LOOKUP_SELECT
		);
		return {
			source_sku: sourceSku,
			sourceProduct: products.get(sourceSku) || null,
			replacements: attachProducts(rows, products),
			magento: magentoStatus,
		};
	}

	// Product preview for the creation modal (catalog + live Magento info).
	async function getProductBySku({ sku }) {
		const wanted = requireSku(sku, 'SKU');
		const { products } = await productsBySku([wanted], PRODUCT_SUMMARY_SELECT, { allowMagentoOnly: true });
		return products.get(wanted) || null;
	}

	// Badges on the expanded order rows: { [sku]: activeCount } (absent = 0).
	async function countActiveBySkus({ skus }) {
		const unique = [...new Set((Array.isArray(skus) ? skus : []).map(normalizeSku).filter(Boolean))];
		if (unique.length === 0) return {};
		if (unique.length > config.countsMaxSkus) {
			throw ProductReplacementError.validation(`Too many SKUs in one call (max ${config.countsMaxSkus})`);
		}
		const groups = await prisma.productReplacement.groupBy({
			by: ['source_sku'],
			where: { source_sku: { in: unique }, deletedAt: null },
			_count: { _all: true },
		});
		return Object.fromEntries(groups.map((group) => [group.source_sku, group._count._all]));
	}

	return {
		listReplacements,
		createReplacements,
		removeReplacement,
		addComment,
		removeComment,
		getReplacementsForSku,
		countActiveBySkus,
		getProductBySku,
	};
}

module.exports = { createProductReplacementsService, USER_SELECT, PRODUCT_SUMMARY_SELECT };
