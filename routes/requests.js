// Rotas HTTP de Requests (chamados internos). Camada fina: valida o shape do
// payload, delega para services/requests/requestsService e mapeia
// RequestServiceError -> status HTTP. Regra de negocio violada responde 409
// (nunca 403 — o interceptor do front desloga o usuario em 403 de auth).

const express = require('express');
const path = require('path');
const multer = require('multer');

const requestsService = require('../services/requests/requestsService');
const { RequestServiceError } = require('../services/requests/errors');
const {
	REQUEST_PRIORITIES,
	DEFAULT_PRIORITY,
	REQUEST_PROJECTS,
	REQUEST_TYPES,
	ATTACHMENT_ALLOWED_TYPES,
	isRequestsUser,
	config: requestsConfig,
} = require('../config/requests');

const router = express.Router();

// --- mapeamento de erros -----------------------------------------------------

const mapError = (req, res, error) => {
	if (error instanceof RequestServiceError) {
		return res.status(error.httpStatus).json({ error: error.message, code: error.code });
	}
	console.error(`Requests route error (${req.method} ${req.originalUrl}):`, error);
	return res.status(500).json({ error: 'Internal server error' });
};

const handle = (fn) => async (req, res) => {
	try {
		await fn(req, res);
	} catch (error) {
		mapError(req, res, error);
	}
};

// --- validacao de shape (dominio fica em lib/requests/transitions) ------------

const parseId = (value) => {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
};

const idParam = (req, name = 'id') => {
	const id = parseId(req.params[name]);
	if (!id) throw RequestServiceError.validation(`Invalid ${name}`);
	return id;
};

const requireText = (value, label, maxLength) => {
	const text = String(value ?? '').trim();
	if (!text) throw RequestServiceError.validation(`${label} is required`);
	if (text.length > maxLength) throw RequestServiceError.validation(`${label} is too long (max ${maxLength} chars)`);
	return text;
};

const requireEnum = (value, allowed, label) => {
	if (!allowed.includes(value)) throw RequestServiceError.validation(`Invalid ${label}`);
	return value;
};

const parseLinks = (links) => {
	if (links === undefined) return undefined;
	if (!Array.isArray(links)) throw RequestServiceError.validation('links must be an array of URLs');
	const cleaned = links.map((link) => String(link ?? '').trim()).filter(Boolean);
	if (cleaned.length > 20) throw RequestServiceError.validation('Too many links (max 20)');
	if (cleaned.some((link) => link.length > 2048)) throw RequestServiceError.validation('Link too long (max 2048 chars)');
	return cleaned;
};

const parseCreateInput = (body = {}) => ({
	title: requireText(body.title, 'Title', 300),
	description: requireText(body.description, 'Description', 20000),
	project: requireEnum(body.project, REQUEST_PROJECTS, 'project'),
	type: requireEnum(body.type, REQUEST_TYPES, 'type'),
	priority: body.priority === undefined
		? DEFAULT_PRIORITY
		: requireEnum(body.priority, REQUEST_PRIORITIES, 'priority'),
	links: parseLinks(body.links) || [],
});

const parsePatch = (body = {}) => {
	const patch = {};
	if (body.title !== undefined) patch.title = requireText(body.title, 'Title', 300);
	if (body.description !== undefined) patch.description = requireText(body.description, 'Description', 20000);
	if (body.project !== undefined) patch.project = requireEnum(body.project, REQUEST_PROJECTS, 'project');
	if (body.type !== undefined) patch.type = requireEnum(body.type, REQUEST_TYPES, 'type');
	if (body.priority !== undefined) patch.priority = requireEnum(body.priority, REQUEST_PRIORITIES, 'priority');
	if (body.links !== undefined) patch.links = parseLinks(body.links);
	if (body.status !== undefined) patch.status = String(body.status); // nome validado na maquina de estados
	// Multi-assignee: assigneeIds = lista completa (primeiro = primario).
	// assigneeId (single) segue aceito por compat e vira lista de 0..1.
	if (body.assigneeIds !== undefined) {
		if (!Array.isArray(body.assigneeIds)) throw RequestServiceError.validation('assigneeIds must be an array');
		const ids = body.assigneeIds.map(parseId);
		if (ids.some((id) => id === null)) throw RequestServiceError.validation('Invalid assigneeIds');
		patch.assigneeIds = [...new Set(ids)];
		patch.assigneeId = patch.assigneeIds[0] ?? null;
	} else if (body.assigneeId !== undefined) {
		patch.assigneeId = body.assigneeId === null ? null : parseId(body.assigneeId);
		if (body.assigneeId !== null && patch.assigneeId === null) {
			throw RequestServiceError.validation('Invalid assigneeId');
		}
		patch.assigneeIds = patch.assigneeId === null ? [] : [patch.assigneeId];
	}
	if (body.comment !== undefined) patch.comment = String(body.comment ?? '');
	// Arquivar (true) / desarquivar (false). Regra no servico: so Completed/Closed.
	if (body.archived !== undefined) patch.archived = Boolean(body.archived);
	return patch;
};

// --- guard: feature exige usuario logado ---------------------------------------
// Com ENABLE_AUTH=false o middleware global nao popula req.user; requests nao
// opera nesse modo (dev local roda com ENABLE_AUTH=true).
router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({
			error: 'Access token required',
			message: 'The requests feature requires authentication (ENABLE_AUTH=true)',
		});
	}
	// Rollout gate: durante o teste a feature so existe para REQUESTS_ALLOWED_USERS.
	// /meta fica aberto (e o que conta ao front se o usuario ve a feature, e a
	// aba Trello do /settings depende de meta.triageUsers para outros usuarios).
	if (req.path !== '/meta' && !isRequestsUser(req.user.username)) {
		return res.status(409).json({
			error: 'The requests feature is not enabled for your user yet',
			code: 'REQUESTS_RESTRICTED',
		});
	}
	next();
});

// --- rotas ---------------------------------------------------------------------
// /meta precisa vir antes de /:id.

router.get('/meta', handle(async (req, res) => {
	res.json(await requestsService.getMeta({ username: req.user.username }));
}));

router.get('/', handle(async (req, res) => {
	res.json(await requestsService.listRequests());
}));

router.post('/', handle(async (req, res) => {
	const input = parseCreateInput(req.body);
	const created = await requestsService.createRequest({ user: req.user, input });
	res.status(201).json(created);
}));

router.get('/:id', handle(async (req, res) => {
	res.json(await requestsService.getRequestDetail(idParam(req)));
}));

router.patch('/:id', handle(async (req, res) => {
	const id = idParam(req);
	const patch = parsePatch(req.body);
	res.json(await requestsService.updateRequest({ user: req.user, id, patch }));
}));

// Cria o card no Trello manualmente ("Create card now" no drawer).
router.post('/:id/trello-card', handle(async (req, res) => {
	const updated = await requestsService.ensureTrelloCard({ user: req.user, id: idParam(req) });
	res.status(201).json(updated);
}));

router.post('/:id/comments', handle(async (req, res) => {
	const id = idParam(req);
	const body = requireText((req.body || {}).body, 'Comment', 20000);
	const internal = Boolean((req.body || {}).internal);
	const comment = await requestsService.addComment({ user: req.user, id, body, internal });
	res.status(201).json(comment);
}));

// --- anexos (DigitalOcean Spaces) -----------------------------------------------

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: requestsConfig.attachmentsMaxFileSizeBytes,
		files: requestsConfig.attachmentsMaxFilesPerUpload,
	},
	fileFilter: (req, file, cb) => {
		const ext = path.extname(file.originalname || '').toLowerCase();
		if (!ATTACHMENT_ALLOWED_TYPES[ext]) {
			return cb(new Error(`File type not allowed: ${ext || '(no extension)'}`));
		}
		cb(null, true);
	},
});

const uploadFiles = upload.array('files');

router.post('/:id/attachments', (req, res) => {
	uploadFiles(req, res, (uploadError) => handle(async () => {
		if (uploadError) {
			if (uploadError.code === 'LIMIT_FILE_SIZE') {
				const maxMb = Math.round(requestsConfig.attachmentsMaxFileSizeBytes / (1024 * 1024));
				return res.status(413).json({ error: `File too large (max ${maxMb} MB)` });
			}
			if (uploadError.code === 'LIMIT_FILE_COUNT') {
				throw RequestServiceError.validation(`Too many files (max ${requestsConfig.attachmentsMaxFilesPerUpload})`);
			}
			throw RequestServiceError.validation(uploadError.message || 'Upload failed');
		}
		const id = idParam(req);
		// Multer/busboy decodifica o filename do multipart como latin1 — nomes
		// com caracteres fora do ASCII (acentos, o espaço U+202F dos screenshots
		// do macOS) viram mojibake ("â€¯"). Reinterpreta os bytes como UTF-8;
		// se sair replacement char e porque ja era UTF-8 valido — mantem.
		const fixFilenameEncoding = (name) => {
			const decoded = Buffer.from(String(name || ''), 'latin1').toString('utf8');
			return decoded.includes('�') ? name : decoded;
		};
		const files = (req.files || []).map((file) => ({
			...file,
			originalname: fixFilenameEncoding(file.originalname),
		}));
		if (!files.length) throw RequestServiceError.validation('No files provided');
		const attachments = await requestsService.addAttachments({ user: req.user, id, files });
		res.status(201).json(attachments);
	})(req, res));
});

router.get('/:id/attachments/:attachmentId/download', handle(async (req, res) => {
	const id = idParam(req);
	const attachmentId = idParam(req, 'attachmentId');
	const { attachment, body, contentLength } = await requestsService.getAttachmentDownload({ id, attachmentId });

	res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
	res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`);
	if (contentLength) res.setHeader('Content-Length', contentLength);
	body.pipe(res);
}));

router.delete('/:id/attachments/:attachmentId', handle(async (req, res) => {
	await requestsService.removeAttachment({
		user: req.user,
		id: idParam(req),
		attachmentId: idParam(req, 'attachmentId'),
	});
	res.status(204).end();
}));

module.exports = router;
