// Casos de uso de Requests (chamados internos). Camada unica de acesso a
// dados da feature: as rotas so traduzem HTTP <-> servico. Regras de
// transicao ficam em lib/requests/transitions (puro); auditoria em
// lib/requests/activity (puro); arquivos em services/storage (Spaces).

const crypto = require('crypto');
const path = require('path');

const prisma = require('../../lib/prisma');
const { validateChange } = require('../../lib/requests/transitions');
const { diffToActivities } = require('../../lib/requests/activity');
const { resolveArchive } = require('../../lib/requests/archive');
const { canManageRequest, canRestoreRequest } = require('../../lib/requests/permissions');
const storage = require('../storage/requestAttachmentsStorage');
const trelloService = require('../trello/trelloService');
const { sendRequestAssignedEmail } = require('../../utils/emailService');
const {
	REQUEST_STATUSES,
	REQUEST_PRIORITIES,
	DEFAULT_PRIORITY,
	REQUEST_PROJECTS,
	REQUEST_TYPES,
	ATTACHMENT_ALLOWED_TYPES,
	isTriageUser,
	isRequestsUser,
	config: requestsConfig,
} = require('../../config/requests');
const { RequestServiceError } = require('./errors');

const USER_SELECT = { id: true, username: true, email: true, firstname: true, lastname: true };

const ASSIGNEES_INCLUDE = { include: { user: { select: USER_SELECT } }, orderBy: { id: 'asc' } };

const LIST_INCLUDE = {
	requester: { select: USER_SELECT },
	assignee: { select: USER_SELECT },
	assignees: ASSIGNEES_INCLUDE,
	_count: { select: { comments: true, attachments: true } },
};

const DETAIL_INCLUDE = {
	requester: { select: USER_SELECT },
	assignee: { select: USER_SELECT },
	assignees: ASSIGNEES_INCLUDE,
	comments: { include: { author: { select: USER_SELECT } }, orderBy: { createdAt: 'asc' } },
	attachments: { include: { uploader: { select: USER_SELECT } }, orderBy: { createdAt: 'asc' } },
	activities: { include: { actor: { select: USER_SELECT } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
};

// --- helpers -----------------------------------------------------------------

// Um chamado deletado (soft delete) deixa de existir para o resto do
// servico: editar, comentar, anexar e criar card no Trello passam por aqui e
// respondem 404. So o restore carrega deletado, de proposito.
async function loadRequestOrFail(id, { includeDeleted = false } = {}) {
	const request = await prisma.request.findUnique({ where: { id } });
	if (!request) throw RequestServiceError.notFound();
	if (request.deletedAt && !includeDeleted) throw RequestServiceError.notFound();
	return request;
}

// Valida e carrega os usuarios da lista, preservando a ordem do payload
// (o primeiro e o assignee primario).
async function resolveAssignees(ids) {
	if (!ids.length) return [];
	const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT });
	if (users.length !== ids.length) throw RequestServiceError.validation('Assignee user not found');
	const byId = new Map(users.map((entry) => [entry.id, entry]));
	return ids.map((id) => byId.get(id));
}

const commentActivity = (requestId, actorId) => ({
	request_id: requestId,
	actor_id: actorId,
	action: 'comment_added',
});

function notifyAssignee({ request, assignee, assignedBy }) {
	if (process.env.REQUESTS_ASSIGNMENT_EMAIL_ENABLED === 'false') return;
	// Fire-and-forget: falha de e-mail nunca bloqueia o update.
	sendRequestAssignedEmail({ request, assignee, assignedBy }).catch((error) => {
		console.error('Request assignment email error:', error.message);
	});
}

// --- meta / listagem ----------------------------------------------------------

async function getMeta({ username } = {}) {
	// trello.configured vem do banco (painel /settings); enabled mantem o nome
	// antigo por compat com o front (RequestTrelloPanel le meta.trello.enabled).
	const trelloConfigured = await trelloService.isConfigured();
	return {
		// Rollout gate: o front usa isto para mostrar/esconder a feature
		// (menu + pagina); o back bloqueia de verdade nas demais rotas.
		requestsEnabled: isRequestsUser(username),
		statuses: REQUEST_STATUSES,
		priorities: REQUEST_PRIORITIES,
		defaultPriority: DEFAULT_PRIORITY,
		projects: REQUEST_PROJECTS,
		types: REQUEST_TYPES,
		triageUsers: requestsConfig.requestsTriageUsers,
		attachments: {
			enabled: storage.isConfigured(),
			maxFileSizeBytes: requestsConfig.attachmentsMaxFileSizeBytes,
			maxFilesPerUpload: requestsConfig.attachmentsMaxFilesPerUpload,
			allowedExtensions: Object.keys(ATTACHMENT_ALLOWED_TYPES),
		},
		trello: { enabled: trelloConfigured, configured: trelloConfigured },
	};
}

// Sem filtro server-side de dominio: volume baixo, filtros/KPIs/busca sao
// client-side (mesmo modelo do CronJobsDashboard). O unico corte no banco e o
// soft delete: deletado nao volta na listagem normal.
function listRequests({ deleted = false } = {}) {
	return prisma.request.findMany({
		where: deleted ? { deletedAt: { not: null } } : { deletedAt: null },
		orderBy: { createdAt: 'desc' },
		include: LIST_INCLUDE,
	});
}

async function getRequestDetail(id, { includeDeleted = false } = {}) {
	const request = await prisma.request.findUnique({ where: { id }, include: DETAIL_INCLUDE });
	if (!request) throw RequestServiceError.notFound();
	// Deletado responde 404 como se nao existisse; so quem pode restaurar ve.
	if (request.deletedAt && !includeDeleted) throw RequestServiceError.notFound();
	return request;
}

// --- criacao ------------------------------------------------------------------

// input ja validado na rota: { title, description, project, type, priority, links }.
// Todo chamado nasce New Request + Unassigned (RF03), independente do payload.
async function createRequest({ user, input }) {
	const created = await prisma.$transaction(async (tx) => {
		const request = await tx.request.create({
			data: { ...input, requester_id: user.id },
		});
		await tx.requestActivity.create({
			data: {
				request_id: request.id,
				actor_id: user.id,
				action: 'created',
				field: 'status',
				newValue: request.status,
			},
		});
		return request;
	});
	return prisma.request.findUnique({ where: { id: created.id }, include: LIST_INCLUDE });
}

// --- update / transicoes --------------------------------------------------------

// patch (ja shape-validado na rota): { title?, description?, project?, type?,
// priority?, links?, status?, assigneeId?, comment? }
async function updateRequest({ user, id, patch }) {
	const current = await loadRequestOrFail(id);
	const isTriage = isTriageUser(user.username);

	const verdict = validateChange({ current, patch, isTriage });
	if (!verdict.ok) throw RequestServiceError.conflict(verdict.error.code, verdict.error.message);

	// Multi-assignee: patch.assigneeIds = lista completa; assignee_id (coluna)
	// guarda o primario (primeiro da lista) e dirige Trello/auto-status/KPIs.
	const touchesAssignees = patch.assigneeIds !== undefined;
	const currentAssignees = touchesAssignees
		? await prisma.requestAssignee.findMany({
			where: { request_id: id },
			include: { user: { select: USER_SELECT } },
			orderBy: { id: 'asc' },
		})
		: [];
	const currentIds = currentAssignees.map((entry) => entry.user_id);
	const newAssignees = touchesAssignees ? await resolveAssignees(patch.assigneeIds) : undefined;
	const assigneesChanged = touchesAssignees
		&& JSON.stringify(currentIds) !== JSON.stringify(patch.assigneeIds);

	const applied = buildAppliedFields({ current, patch, autoStatus: verdict.autoStatus });

	// Arquivamento: regra pura em lib/requests/archive (autor ou triage).
	const archive = resolveArchive({ current, patch, user, isTriage });
	if (!archive.ok) throw RequestServiceError.conflict(archive.error.code, archive.error.message);
	const archivedChanged = archive.changed;
	if (archivedChanged) applied.archivedAt = archive.archivedAt;

	const commentBody = String(patch.comment || '').trim();

	if (!Object.keys(applied).length && !commentBody && !assigneesChanged) {
		throw RequestServiceError.validation('Nothing to update');
	}

	const assigneeLabel = (list) => (list.length ? list.map((entry) => entry.username).join(', ') : null);
	const oldLabel = assigneeLabel(currentAssignees.map((entry) => entry.user));
	const newLabel = newAssignees ? assigneeLabel(newAssignees) : null;

	const activities = diffToActivities({
		requestId: id,
		actorId: user.id,
		current,
		applied,
		labels: { oldAssignee: oldLabel, newAssignee: newLabel },
	});
	if (archivedChanged) {
		activities.push({
			request_id: id,
			actor_id: user.id,
			action: archive.archivedAt ? 'archived' : 'unarchived',
			field: 'archived',
		});
	}
	// Troca so nos co-responsaveis (primario igual) nao aparece no diff de
	// colunas — registra a mudanca da lista aqui.
	if (assigneesChanged && !activities.some((entry) => entry.action === 'assignee_change')) {
		activities.push({
			request_id: id,
			actor_id: user.id,
			action: 'assignee_change',
			field: 'assignee',
			oldValue: oldLabel,
			newValue: newLabel,
		});
	}
	if (commentBody) activities.push(commentActivity(id, user.id));

	await prisma.$transaction(async (tx) => {
		if (Object.keys(applied).length) {
			await tx.request.update({ where: { id }, data: applied });
		}
		if (assigneesChanged) {
			await tx.requestAssignee.deleteMany({ where: { request_id: id } });
			if (patch.assigneeIds.length) {
				await tx.requestAssignee.createMany({
					data: patch.assigneeIds.map((userId) => ({ request_id: id, user_id: userId })),
				});
			}
		}
		if (commentBody) {
			await tx.requestComment.create({
				data: { request_id: id, author_id: user.id, body: commentBody },
			});
		}
		if (activities.length) {
			await tx.requestActivity.createMany({ data: activities });
		}
	});

	// E-mail de atribuicao para cada pessoa RECEM-adicionada a lista.
	if (newAssignees) {
		for (const added of newAssignees.filter((entry) => !currentIds.includes(entry.id))) {
			notifyAssignee({ request: { ...current, ...applied, id }, assignee: added, assignedBy: user });
		}
	}

	// Ao entrar em Assigned sem card, cria o card no Trello (fire-and-forget —
	// falha nunca bloqueia a transicao; ha o botao "Create card now" de fallback).
	if (applied.status === 'Assigned' && !current.trelloCardId) {
		autoCreateTrelloCard({ user, id });
	}

	return getRequestDetail(id);
}

// --- trello ---------------------------------------------------------------------

// Requests com criacao de card em voo (trava in-process; producao roda em
// instancia unica). Evita card duplicado no Trello — ver ensureTrelloCard.
const trelloCardsInFlight = new Set();

// Codes de negocio do trelloService que viram 409 (toast no front, nunca 500).
const TRELLO_CONFLICT_CODES = new Set([
	'TRELLO_NOT_CONFIGURED',
	'TRELLO_NO_ASSIGNEE',
	'TRELLO_NO_BOARD_FOR_USER',
	'TRELLO_AUTH_FAILED',
	'TRELLO_RATE_LIMITED',
	'TRELLO_UNAVAILABLE',
]);

async function ensureTrelloCard({ user, id }) {
	const request = await prisma.request.findUnique({
		where: { id },
		include: { requester: { select: USER_SELECT }, assignee: { select: USER_SELECT } },
	});
	if (!request || request.deletedAt) throw RequestServiceError.notFound();
	if (request.trelloCardId) {
		throw RequestServiceError.conflict('CARD_EXISTS', 'A Trello card is already linked to this request');
	}
	// A criacao demora (rede): sem esta trava o auto-create disparado pela
	// transicao e o botao "Create card now" leem trelloCardId null ao mesmo
	// tempo e criam DOIS cards no Trello.
	if (trelloCardsInFlight.has(id)) {
		throw RequestServiceError.conflict('CARD_IN_PROGRESS', 'A Trello card is already being created for this request');
	}
	trelloCardsInFlight.add(id);

	let card;
	try {
		card = await trelloService.createCardForRequest(request);
	} catch (error) {
		if (TRELLO_CONFLICT_CODES.has(error.code)) {
			throw RequestServiceError.conflict(error.code, error.message);
		}
		throw error;
	} finally {
		trelloCardsInFlight.delete(id);
	}

	// Update condicional: se outro processo gravou primeiro, nao sobrescreve o
	// card dele (o nosso vira orfao no Trello — logado para reconciliar).
	const claimed = await prisma.request.updateMany({
		where: { id, trelloCardId: null },
		data: { trelloCardId: card.cardId, trelloCardUrl: card.cardUrl },
	});
	if (claimed.count === 0) {
		console.error(`Trello card ${card.cardId} created for request ${id} but another card was already linked; leaving it orphaned in Trello`);
		return getRequestDetail(id);
	}

	await prisma.requestActivity.create({
		data: {
			request_id: id,
			actor_id: user.id,
			action: 'trello_card_created',
			field: 'trello',
			newValue: card.cardUrl,
		},
	});

	return getRequestDetail(id);
}

// Auto-create na transicao para Assigned. Fire-and-forget: nunca lanca.
//
// Enquanto a integracao nao estiver COMPLETAMENTE configurada (sem
// credencial, ou o assignee ainda sem board mapeado no painel /settings), a
// sincronizacao simplesmente nao acontece: nada de card, nada de entrada no
// historico do chamado (decisao do Ricardo, 2026-08-06 — o log so poluiria a
// tela durante o periodo de configuracao). O motivo fica no log do servidor.
//
// Ja uma falha REAL com tudo configurado (credencial revogada, API do Trello
// fora) vira 'trello_card_failed' no activity log, porque ai o time precisa
// saber que o card nao existe. O botao "Create card now" continua explicando
// o motivo em qualquer caso (409), por ser acao explicita do usuario.
const TRELLO_SILENT_CODES = new Set([
	'TRELLO_NOT_CONFIGURED',
	'TRELLO_NO_ASSIGNEE',
	'TRELLO_NO_BOARD_FOR_USER',
	'CARD_EXISTS',
	'CARD_IN_PROGRESS',
]);

function autoCreateTrelloCard({ user, id }) {
	ensureTrelloCard({ user, id }).catch(async (error) => {
		if (TRELLO_SILENT_CODES.has(error.code)) {
			// Configuracao incompleta: nao sincroniza e nao polui a tela.
			console.log(`Trello sync skipped for request ${id}: ${error.message}`);
			return;
		}
		console.error(`Trello card creation failed for request ${id}:`, error.message);

		// Enquanto a causa nao muda (ex.: API fora), toda reentrada em Assigned
		// tentaria de novo e gravaria a mesma linha: registra so quando a ultima
		// entrada de Trello for diferente, para nao poluir o historico.
		const last = await prisma.requestActivity.findFirst({
			where: { request_id: id, field: 'trello' },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			select: { action: true, newValue: true },
		}).catch(() => null);
		if (last && last.action === 'trello_card_failed' && last.newValue === error.message) return;

		await prisma.requestActivity.create({
			data: {
				request_id: id,
				actor_id: user.id,
				action: 'trello_card_failed',
				field: 'trello',
				newValue: error.message,
			},
		}).catch((activityError) => {
			console.error(`Trello activity write failed for request ${id}:`, activityError.message);
		});
	});
}

function buildAppliedFields({ current, patch, autoStatus }) {
	const applied = {};
	for (const field of ['title', 'description', 'project', 'type', 'priority', 'links']) {
		if (patch[field] !== undefined) applied[field] = patch[field];
	}
	if (patch.assigneeId !== undefined) applied.assignee_id = patch.assigneeId;
	const status = patch.status !== undefined ? patch.status : autoStatus;
	if (status !== undefined && status !== current.status) applied.status = status;
	return applied;
}

// --- soft delete ------------------------------------------------------------------

// Deletar aqui NAO apaga nada: marca o chamado e ele some da tela para todos.
// Comentarios, anexos no bucket e o card do Trello continuam intactos — foi a
// escolha de produto justamente para clique errado nao destruir historico.
async function softDeleteRequest({ user, id }) {
	const current = await loadRequestOrFail(id);

	const isTriage = isTriageUser(user.username);
	if (!canManageRequest({ request: current, user, isTriage })) {
		throw RequestServiceError.conflict(
			'NOT_OWNER',
			'Only the person who opened the request or a triage user can delete it'
		);
	}

	await prisma.$transaction([
		prisma.request.update({
			where: { id },
			data: { deletedAt: new Date(), deletedById: user.id },
		}),
		prisma.requestActivity.create({
			data: { request_id: id, actor_id: user.id, action: 'deleted', field: 'deleted' },
		}),
	]);
}

// Restaurar e exclusivo de triage: deletar e do autor, desfazer e de quem
// cuida da fila.
async function restoreRequest({ user, id }) {
	// Permissao antes do estado: responder "nao esta deletado" para quem nao
	// pode restaurar entregaria de graca quais ids estao na lixeira.
	if (!canRestoreRequest({ isTriage: isTriageUser(user.username) })) {
		throw RequestServiceError.conflict('TRIAGE_ONLY', 'Only triage users can restore a deleted request');
	}

	const current = await loadRequestOrFail(id, { includeDeleted: true });
	if (!current.deletedAt) throw RequestServiceError.validation('Request is not deleted');

	await prisma.$transaction([
		prisma.request.update({ where: { id }, data: { deletedAt: null, deletedById: null } }),
		prisma.requestActivity.create({
			data: { request_id: id, actor_id: user.id, action: 'restored', field: 'deleted' },
		}),
	]);
	return getRequestDetail(id);
}

// --- comentarios ----------------------------------------------------------------

// Todo comentario e visivel para quem abre o chamado. Existiu uma flag
// "internal" que prometia esconder do autor e nunca escondeu nada (nenhum
// filtro na leitura); removida em 2026-08-07 em vez de virar uma promessa
// falsa sobre quem le o que.
async function addComment({ user, id, body }) {
	await loadRequestOrFail(id);
	return prisma.$transaction(async (tx) => {
		const comment = await tx.requestComment.create({
			data: { request_id: id, author_id: user.id, body },
			include: { author: { select: USER_SELECT } },
		});
		await tx.requestActivity.create({ data: commentActivity(id, user.id) });
		return comment;
	});
}

// --- anexos ----------------------------------------------------------------------

function assertAttachmentsEnabled() {
	if (!storage.isConfigured()) {
		throw RequestServiceError.conflict(
			'ATTACHMENTS_DISABLED',
			'Attachment storage is not configured (DO_SPACES_*)'
		);
	}
}

// files: array do multer (memoryStorage): { originalname, mimetype, size, buffer }
async function addAttachments({ user, id, files }) {
	assertAttachmentsEnabled();
	await loadRequestOrFail(id);

	const uploaded = [];
	try {
		for (const file of files) {
			const ext = path.extname(file.originalname || '').toLowerCase();
			const storedName = `${crypto.randomUUID()}${ext}`;
			await storage.putAttachment({
				requestId: id,
				storedName,
				body: file.buffer,
				contentType: file.mimetype,
			});
			uploaded.push({
				request_id: id,
				uploader_id: user.id,
				originalName: file.originalname || storedName,
				storedName,
				mimeType: file.mimetype || 'application/octet-stream',
				sizeBytes: file.size,
			});
		}

		return await prisma.$transaction(async (tx) => {
			await tx.requestAttachment.createMany({ data: uploaded });
			await tx.requestActivity.create({
				data: {
					request_id: id,
					actor_id: user.id,
					action: 'attachment_added',
					field: 'attachments',
					newValue: uploaded.map((row) => row.originalName).join(', ').slice(0, 300),
				},
			});
			return tx.requestAttachment.findMany({
				where: { storedName: { in: uploaded.map((row) => row.storedName) } },
				include: { uploader: { select: USER_SELECT } },
			});
		});
	} catch (error) {
		// Nao deixar orfaos no bucket se o banco falhar no meio.
		await Promise.allSettled(
			uploaded.map((row) => storage.deleteAttachment({ requestId: id, storedName: row.storedName }))
		);
		throw error;
	}
}

async function getAttachmentDownload({ id, attachmentId }) {
	const attachment = await prisma.requestAttachment.findFirst({
		where: { id: attachmentId, request_id: id, request: { deletedAt: null } },
	});
	if (!attachment) throw RequestServiceError.notFound('Attachment not found');
	assertAttachmentsEnabled();

	try {
		const { body, contentLength } = await storage.getAttachmentStream({
			requestId: id,
			storedName: attachment.storedName,
		});
		return { attachment, body, contentLength };
	} catch (error) {
		if (error && (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey')) {
			throw RequestServiceError.notFound('Attachment file missing in storage');
		}
		throw error;
	}
}

async function removeAttachment({ user, id, attachmentId }) {
	const attachment = await prisma.requestAttachment.findFirst({
		where: { id: attachmentId, request_id: id, request: { deletedAt: null } },
	});
	if (!attachment) throw RequestServiceError.notFound('Attachment not found');

	if (attachment.uploader_id !== user.id && !isTriageUser(user.username)) {
		throw RequestServiceError.conflict('NOT_OWNER', 'Only the uploader or triage can delete an attachment');
	}

	await prisma.$transaction([
		prisma.requestAttachment.delete({ where: { id: attachment.id } }),
		prisma.requestActivity.create({
			data: {
				request_id: id,
				actor_id: user.id,
				action: 'attachment_removed',
				field: 'attachments',
				oldValue: attachment.originalName,
			},
		}),
	]);

	// Melhor esforco: a linha ja saiu do banco; falha aqui so deixa lixo no bucket.
	storage.deleteAttachment({ requestId: id, storedName: attachment.storedName }).catch((error) => {
		console.error('Attachment storage delete error:', error.message);
	});
}

module.exports = {
	getMeta,
	listRequests,
	getRequestDetail,
	createRequest,
	updateRequest,
	addComment,
	addAttachments,
	softDeleteRequest,
	restoreRequest,
	getAttachmentDownload,
	removeAttachment,
	ensureTrelloCard,
};
