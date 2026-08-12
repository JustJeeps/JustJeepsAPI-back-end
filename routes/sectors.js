// Rotas HTTP de Setores (boards por setor da feature Requests). Camada fina
// sobre services/sectors/sectorsService. Regra de negocio violada responde
// 409 (nunca 403 — o interceptor do front desloga o usuario em 403 de auth).
//
// Permissoes: qualquer requests user LE os setores (visibilidade aberta por
// decisao de produto); criar e triage-only; gerenciar (membros, rename,
// board do Trello) e triage ou admin DO setor. As rotas de leitura do Trello
// (boards/listas, para o dropdown do mapping) vivem AQUI e nao em
// /api/trello-settings de proposito: aquele router e triage-gated inteiro e
// credenciais continuam so com triage.

const express = require('express');

const sectorsService = require('../services/sectors/sectorsService');
const trelloSettingsService = require('../services/trello/trelloSettingsService');
const { RequestServiceError } = require('../services/requests/errors');
const { isRequestsUser, isTriageUser } = require('../config/requests');

const router = express.Router();

const mapError = (req, res, error) => {
	if (error instanceof RequestServiceError) {
		return res.status(error.httpStatus).json({ error: error.message, code: error.code });
	}
	console.error(`Sectors route error (${req.method} ${req.originalUrl}):`, error);
	return res.status(500).json({ error: 'Internal server error' });
};

const handle = (fn) => async (req, res) => {
	try {
		await fn(req, res);
	} catch (error) {
		mapError(req, res, error);
	}
};

const idParam = (req, name = 'id') => {
	const id = Number(req.params[name]);
	if (!Number.isInteger(id) || id <= 0) throw RequestServiceError.validation(`Invalid ${name}`);
	return id;
};

// --- guard: exige usuario logado + rollout gate de requests --------------------
// Guard proprio (padrao routes/users.js:7-17): um deploy com ENABLE_AUTH
// errado deixaria o middleware global sem popular req.user.
router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Access token required' });
	}
	if (!isRequestsUser(req.user.username)) {
		return res.status(409).json({
			error: 'The requests feature is not enabled for your user yet',
			code: 'REQUESTS_RESTRICTED',
		});
	}
	next();
});

// --- gate de configuracao ------------------------------------------------------
// Configuracao de setor (membros, mapping do Trello, audit) e para triage ou
// admin de ALGUM setor — member ve o board de chamados, nao a configuracao
// (decisao de 2026-08-12). Credenciais seguem exclusivas de /api/trello-settings.

const requireSectorAdmin = async (req, res, next) => {
	try {
		if (!isTriageUser(req.user.username)) {
			const adminSectors = await sectorsService.adminSectorIdsFor(req.user.id);
			if (!adminSectors.length) {
				throw RequestServiceError.conflict(
					'SECTOR_ADMIN_ONLY',
					'Sector settings are restricted to sector admins and triage users'
				);
			}
		}
		next();
	} catch (error) {
		mapError(req, res, error);
	}
};

router.get('/trello/boards', requireSectorAdmin, handle(async (req, res) => {
	res.json(await trelloSettingsService.listBoards());
}));

router.get('/trello/boards/:boardId/lists', requireSectorAdmin, handle(async (req, res) => {
	const boardId = String(req.params.boardId || '').trim();
	if (!boardId) throw RequestServiceError.validation('Invalid boardId');
	res.json(await trelloSettingsService.listBoardLists(boardId));
}));

// --- setores -------------------------------------------------------------------

// Configuracao: triage recebe todos; admin de setor recebe SO os setores que
// administra. O catalogo publico (nomes para criar/mover) vive no /meta.
router.get('/', requireSectorAdmin, handle(async (req, res) => {
	res.json(await sectorsService.listSectors({ user: req.user }));
}));

router.post('/', handle(async (req, res) => {
	const created = await sectorsService.createSector({
		user: req.user,
		name: req.body?.name,
		color: req.body?.color,
	});
	res.status(201).json(created);
}));

router.patch('/:id', handle(async (req, res) => {
	const patch = {};
	if (req.body?.name !== undefined) patch.name = req.body.name;
	if (req.body?.color !== undefined) patch.color = req.body.color;
	if (req.body?.archived !== undefined) patch.archived = Boolean(req.body.archived);
	res.json(await sectorsService.updateSector({ user: req.user, sectorId: idParam(req), patch }));
}));

// --- membros -------------------------------------------------------------------

router.put('/:id/members/:userId', handle(async (req, res) => {
	res.json(await sectorsService.setMember({
		user: req.user,
		sectorId: idParam(req),
		userId: idParam(req, 'userId'),
		role: String(req.body?.role || ''),
	}));
}));

router.delete('/:id/members/:userId', handle(async (req, res) => {
	res.json(await sectorsService.removeMember({
		user: req.user,
		sectorId: idParam(req),
		userId: idParam(req, 'userId'),
	}));
}));

// --- board do Trello do setor ---------------------------------------------------

router.put('/:id/trello-board', handle(async (req, res) => {
	const saved = await sectorsService.saveSectorTrelloBoard({
		user: req.user,
		sectorId: idParam(req),
		boardId: req.body?.boardId ?? null,
		boardName: req.body?.boardName,
		listId: req.body?.listId,
		listName: req.body?.listName,
	});
	if (!saved) return res.status(204).end();
	res.json(saved);
}));

// --- audit ---------------------------------------------------------------------

router.get('/:id/activity', handle(async (req, res) => {
	res.json(await sectorsService.getSectorActivity({ user: req.user, sectorId: idParam(req) }));
}));

module.exports = router;
