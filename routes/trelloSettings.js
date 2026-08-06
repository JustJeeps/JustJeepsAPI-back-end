// Rotas HTTP da configuracao Trello (painel /settings). Camada fina sobre
// services/trello/trelloSettingsService. Restrito a usuarios de triage —
// validado AQUI no back (o front so esconde a engrenagem). Regra de negocio
// violada responde 409 (nunca 403 — o interceptor do front desloga em 403).

const express = require('express');

const trelloSettingsService = require('../services/trello/trelloSettingsService');
const { RequestServiceError } = require('../services/requests/errors');
const { isTriageUser } = require('../config/requests');

const router = express.Router();

const mapError = (req, res, error) => {
	if (error instanceof RequestServiceError) {
		return res.status(error.httpStatus).json({ error: error.message, code: error.code });
	}
	console.error(`Trello settings route error (${req.method} ${req.originalUrl}):`, error);
	return res.status(500).json({ error: 'Internal server error' });
};

const handle = (fn) => async (req, res) => {
	try {
		await fn(req, res);
	} catch (error) {
		mapError(req, res, error);
	}
};

// --- guard: exige usuario logado E de triage -----------------------------------

router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Access token required' });
	}
	if (!isTriageUser(req.user.username)) {
		return res.status(409).json({
			error: 'Trello settings are restricted to triage users',
			code: 'TRIAGE_ONLY',
		});
	}
	next();
});

// --- credencial global ---------------------------------------------------------

router.get('/', handle(async (req, res) => {
	res.json(await trelloSettingsService.getSettingsRedacted());
}));

router.put('/', handle(async (req, res) => {
	res.json(await trelloSettingsService.saveSettings({
		user: req.user,
		apiKey: req.body?.apiKey,
		apiToken: req.body?.apiToken,
	}));
}));

router.delete('/', handle(async (req, res) => {
	await trelloSettingsService.disableIntegration();
	res.status(204).end();
}));

router.post('/test', handle(async (req, res) => {
	res.json(await trelloSettingsService.testConnection({
		apiKey: req.body?.apiKey,
		apiToken: req.body?.apiToken,
	}));
}));

// --- boards/listas da conta configurada ----------------------------------------

router.get('/boards', handle(async (req, res) => {
	res.json(await trelloSettingsService.listBoards());
}));

router.get('/boards/:boardId/lists', handle(async (req, res) => {
	const boardId = String(req.params.boardId || '').trim();
	if (!boardId) throw RequestServiceError.validation('Invalid boardId');
	res.json(await trelloSettingsService.listBoardLists(boardId));
}));

// --- mapeamento usuario -> board/lista -----------------------------------------

router.get('/user-boards', handle(async (req, res) => {
	res.json(await trelloSettingsService.getUserBoards());
}));

router.put('/user-boards/:userId', handle(async (req, res) => {
	const userId = Number(req.params.userId);
	if (!Number.isInteger(userId) || userId <= 0) throw RequestServiceError.validation('Invalid userId');

	const saved = await trelloSettingsService.saveUserBoard({
		userId,
		boardId: req.body?.boardId ?? null,
		boardName: req.body?.boardName,
		listId: req.body?.listId,
		listName: req.body?.listName,
	});
	if (!saved) return res.status(204).end();
	res.json(saved);
}));

module.exports = router;
