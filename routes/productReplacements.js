// HTTP routes of the Product Replacement feature (docs/PRODUCT-REPLACEMENTS.md).
// Thin layer: validates the payload shape, delegates to
// services/productReplacements/productReplacementsService and maps
// ProductReplacementError -> HTTP status. A business rule violation answers
// 409 with a code (never 403: the frontend interceptor logs the user out on
// an auth 403).

const express = require('express');

const {
	isReplacementsUser,
	isReplacementsManager,
	config: replacementsConfig,
	SKU_MAX_LENGTH,
	COMMENT_MAX_LENGTH,
	LIST_MAX,
	COUNTS_MAX_SKUS,
	CREATE_MAX_BATCH,
} = require('../config/productReplacements');
const { ProductReplacementError } = require('../services/productReplacements/errors');
const { createProductReplacementsService } = require('../services/productReplacements/productReplacementsService');
const { createMagentoProductInfoClient } = require('../lib/magento/productInfoClient');
const { describeHttpError } = require('../lib/magento/describeHttpError');

const SEARCH_MAX_LENGTH = 100;

const SERVICE_CONFIG = {
	skuMaxLength: SKU_MAX_LENGTH,
	commentMaxLength: COMMENT_MAX_LENGTH,
	listMax: LIST_MAX,
	countsMaxSkus: COUNTS_MAX_SKUS,
	createMaxBatch: CREATE_MAX_BATCH,
};

// --- error mapping -------------------------------------------------------------

const mapError = (req, res, error) => {
	if (error instanceof ProductReplacementError) {
		return res.status(error.httpStatus).json({ error: error.message, code: error.code });
	}
	// describeHttpError strips an axios error down to safe fields (the raw one
	// carries the Bearer token); Prisma errors keep their code (P1001 = DB
	// unreachable, P2003 = FK) so the log says which failure it was.
	const described = describeHttpError(error);
	console.error(`Product replacements route error (${req.method} ${req.originalUrl}):`, error && error.code && described === error
		? { code: error.code, message: String(error.message || '').slice(0, 300), stack: error.stack }
		: described);
	return res.status(500).json({ error: 'Internal server error', ...(error && error.code && !error.isAxiosError ? { code: String(error.code) } : {}) });
};

const handle = (fn) => async (req, res) => {
	try {
		await fn(req, res);
	} catch (error) {
		mapError(req, res, error);
	}
};

// --- shape validation (business rules live in the service) ---------------------

const parseId = (value) => {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
};

const idParam = (req, name) => {
	const id = parseId(req.params[name]);
	if (!id) throw ProductReplacementError.validation(`Invalid ${name}`);
	return id;
};

const parseSkuList = (value) => String(value ?? '')
	.split(',')
	.map((sku) => sku.trim())
	.filter(Boolean);

function createProductReplacementsRouter({
	service,
	isManager = isReplacementsManager,
	managers = replacementsConfig.replacementsManagerUsers,
	isAllowedUser = isReplacementsUser,
}) {
	const router = express.Router();

	// The feature needs a logged in user (author of every write). With
	// ENABLE_AUTH=false the global middleware does not populate req.user.
	router.use((req, res, next) => {
		if (!req.user) {
			return res.status(401).json({
				error: 'Access token required',
				message: 'The product replacements feature requires authentication (ENABLE_AUTH=true)',
			});
		}
		next();
	});

	// Static paths first, so they are not read as /:id.

	// Lets the frontend hide what the caller cannot use: the whole feature
	// outside the rollout list (`enabled`), the Remove buttons for
	// non-managers. The backend still enforces both on every route.
	router.get('/meta', (req, res) => {
		res.json({ enabled: isAllowedUser(req.user), isManager: isManager(req.user.username), managers });
	});

	// Rollout gate (REPLACEMENTS_ALLOWED_USERS): 409 with a code, never 403,
	// so the frontend interceptor does not log the user out.
	router.use((req, res, next) => {
		if (!isAllowedUser(req.user)) {
			return res.status(409).json({
				error: 'The product replacements feature is not available for your user yet',
				code: 'REPLACEMENTS_RESTRICTED',
			});
		}
		next();
	});

	// Badges on the Orders screen: ?skus=A,B,C -> { counts: { A: 2 } }
	router.get('/counts', handle(async (req, res) => {
		const skus = parseSkuList(req.query.skus);
		if (skus.length === 0) return res.json({ counts: {} });
		const counts = await service.countActiveBySkus({ skus });
		res.json({ counts });
	}));

	// Product preview for the creation modal: catalog + live Magento info.
	router.get('/products/:sku', handle(async (req, res) => {
		const product = await service.getProductBySku({ sku: req.params.sku });
		if (!product) throw ProductReplacementError.notFound('SKU_NOT_FOUND', `SKU ${req.params.sku} was not found`);
		res.json(product);
	}));

	// Replacement Lookup drawer: everything registered for one source SKU.
	router.get('/for-sku/:sku', handle(async (req, res) => {
		res.json(await service.getReplacementsForSku({ sku: req.params.sku }));
	}));

	// Directory (management screen).
	router.get('/', handle(async (req, res) => {
		const search = req.query.search === undefined ? '' : String(req.query.search);
		if (search.length > SEARCH_MAX_LENGTH) {
			throw ProductReplacementError.validation(`Search is too long (max ${SEARCH_MAX_LENGTH} chars)`);
		}
		res.json(await service.listReplacements({ search }));
	}));

	// Create: one original, one or more replacements, each with its own comment.
	// Create: one original with one or more replacements (each with its own
	// comment), or `no_replacement: true` with the required comment.
	router.post('/', handle(async (req, res) => {
		const body = req.body || {};
		const noReplacement = body.no_replacement === true;
		if (!noReplacement && !Array.isArray(body.replacements)) {
			throw ProductReplacementError.validation('replacements must be a list');
		}
		const replacements = (Array.isArray(body.replacements) ? body.replacements : []).map((entry) => ({
			replacement_sku: entry && entry.replacement_sku,
			comment: entry && entry.comment,
		}));
		const created = await service.createReplacements({
			user: req.user,
			source_sku: body.source_sku,
			replacements,
			...(noReplacement ? { no_replacement: true, comment: body.comment } : {}),
		});
		res.status(201).json(created);
	}));

	router.delete('/:id', handle(async (req, res) => {
		res.json(await service.removeReplacement({ user: req.user, id: idParam(req, 'id') }));
	}));

	router.post('/:id/comments', handle(async (req, res) => {
		const comment = await service.addComment({
			user: req.user,
			id: idParam(req, 'id'),
			body: (req.body || {}).body,
		});
		res.status(201).json(comment);
	}));

	router.delete('/:id/comments/:commentId', handle(async (req, res) => {
		res.json(await service.removeComment({
			user: req.user,
			id: idParam(req, 'id'),
			commentId: idParam(req, 'commentId'),
		}));
	}));

	return router;
}

// Router used by server.js (real prisma). The factory above is what the
// route test builds with a fake service.
function createDefaultRouter() {
	const prisma = require('../lib/prisma');
	if (!process.env.MAGENTO_KEY) {
		console.warn('[product-replacements] MAGENTO_KEY is not set: product cards will use the catalog snapshot, not the live store');
	}
	const service = createProductReplacementsService({
		prisma,
		config: SERVICE_CONFIG,
		isManager: isReplacementsManager,
		// Live name, image, description and store page from Magento (falls
		// back to the Product table when the API is down or MAGENTO_KEY is unset).
		magento: createMagentoProductInfoClient({ logger: console }),
	});
	return createProductReplacementsRouter({
		service,
		isManager: isReplacementsManager,
		managers: replacementsConfig.replacementsManagerUsers,
	});
}

module.exports = { createProductReplacementsRouter, createDefaultRouter, SERVICE_CONFIG };
