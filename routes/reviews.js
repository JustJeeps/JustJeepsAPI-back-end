// Import de reviews de produtos para o Magento (docs/REVIEWS-IMPORT.md).
// Rota fina: validacao de shape aqui, caso de uso nos services/reviews, regra
// pura em lib/reviews. Regra de negocio responde 409/400/404, NUNCA 403 — o
// interceptor do front desloga o usuario em 403 de auth (routes/ingest.js:1-4).

const express = require('express');
const multer = require('multer');
const path = require('path');

const { isReviewsUser, REVIEWS_ALLOWED_TYPES, config: reviewsConfig } = require('../config/reviews');
const { ReviewsServiceError } = require('../services/reviews/errors');
const prisma = require('../lib/prisma');
const { parseWorkbookBuffer } = require('../lib/reviews/parseWorkbook');
const { createReviewImportService } = require('../services/reviews/reviewImportService');
const { createReviewSyncService } = require('../services/reviews/reviewSyncService');
const { createMagentoReviewsClient } = require('../lib/magento/reviewsClient');
const { createFeedStore } = require('../lib/feeds/feedStore');

const router = express.Router();

// O store e o mesmo do bucket DO Spaces (staging transitorio do arquivo em
// review-imports/ — apagado quando o import fecha ready).
const importService = createReviewImportService({
	prisma,
	config: reviewsConfig,
	parseWorkbookBuffer,
	store: createFeedStore(),
});
const syncService = createReviewSyncService({
	prisma,
	magentoClient: createMagentoReviewsClient(),
	config: reviewsConfig,
});

// --- mapeamento de erros -----------------------------------------------------

const mapError = (req, res, error) => {
	if (error instanceof ReviewsServiceError) {
		return res.status(error.httpStatus).json({ error: error.message, code: error.code });
	}
	console.error(`Reviews route error (${req.method} ${req.originalUrl}):`, error);
	return res.status(500).json({ error: 'Internal server error' });
};

const handle = (fn) => async (req, res) => {
	try {
		await fn(req, res);
	} catch (error) {
		mapError(req, res, error);
	}
};

// --- guards ------------------------------------------------------------------
// 401 sem usuario (a rota nao opera com ENABLE_AUTH=false); 409 fora da
// allowlist. /meta fica FORA do gate: e o que o front usa para esconder a aba.

router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({
			error: 'Access token required',
			message: 'The reviews import requires authentication (ENABLE_AUTH=true)',
		});
	}
	if (req.path !== '/meta' && !isReviewsUser(req.user.username)) {
		return res.status(409).json({
			error: 'The reviews import is not enabled for your user',
			code: 'REVIEWS_RESTRICTED',
		});
	}
	next();
});

// --- upload (multer DEPOIS do gate: ninguem fora da allowlist ocupa memoria) --
// memoryStorage: a planilha real tem ~1.4MB e o teto e 10MB. Limites de
// parts/fields copiados do routes/ingest.js:35-41 (o molde de requests nao os
// tem e deixaria campos nao-arquivo ilimitados).

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: reviewsConfig.maxUploadBytes,
		files: 1,
		fields: 4,
		parts: 8,
		fieldSize: 4096,
	},
	fileFilter: (req, file, cb) => {
		const ext = path.extname(file.originalname || '').toLowerCase();
		const allowedTypes = REVIEWS_ALLOWED_TYPES[ext];
		if (!allowedTypes) return cb(new Error(`File type not allowed: ${ext || '(no extension)'}`));
		if (!allowedTypes.includes(file.mimetype)) {
			return cb(new Error(`File content type not allowed for ${ext}: ${file.mimetype}`));
		}
		cb(null, true);
	},
});
const uploadSingle = upload.single('file');

// multer manda o filename em latin1; o guard do replacement char evita
// corromper nomes que ja chegaram em UTF-8 (routes/requests.js:279-286).
const fixFilenameEncoding = (name) => {
	const decoded = Buffer.from(String(name || ''), 'latin1').toString('utf8');
	return decoded.includes('�') ? name : decoded;
};

// --- rotas -------------------------------------------------------------------

router.get('/meta', handle(async (req, res) => {
	// So valores derivados — nunca env cru, nunca a allowlist inteira.
	res.json({
		enabled: isReviewsUser(req.user.username),
		batchSize: reviewsConfig.batchSize,
		batchDelayMs: reviewsConfig.batchDelayMs,
		maxUploadBytes: reviewsConfig.maxUploadBytes,
		allowedExtensions: Object.keys(REVIEWS_ALLOWED_TYPES),
	});
}));

router.get('/files', handle(async (req, res) => {
	res.json(await importService.listFiles());
}));

router.post('/files', handle(async (req, res) => {
	await new Promise((resolve, reject) => {
		uploadSingle(req, res, (error) => {
			if (!error) return resolve();
			if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
				const maxMb = Math.round(reviewsConfig.maxUploadBytes / 1024 / 1024);
				return reject(new ReviewsServiceError('FILE_TOO_LARGE', `File exceeds the ${maxMb}MB limit`, 413));
			}
			return reject(ReviewsServiceError.validation(error.message || 'Upload failed'));
		});
	});
	if (!req.file) throw ReviewsServiceError.validation('Send the spreadsheet in the "file" field');

	const file = {
		originalname: fixFilenameEncoding(req.file.originalname),
		buffer: req.file.buffer,
		size: req.file.size,
	};
	const result = await importService.uploadFile({ user: req.user, file });
	res.status(201).json(result);
}));

const idParam = (req) => {
	const id = Number(req.params.id);
	if (!Number.isInteger(id) || id <= 0) throw ReviewsServiceError.validation('Invalid file id');
	return id;
};

router.post('/files/:id/sync', handle(async (req, res) => {
	const { runId } = await syncService.startSync({ user: req.user, fileId: idParam(req) });
	res.status(202).json({ runId });
}));

router.post('/files/:id/retry-failed', handle(async (req, res) => {
	res.json(await syncService.retryFailed({ fileId: idParam(req) }));
}));

module.exports = router;
