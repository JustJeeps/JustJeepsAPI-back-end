// Casos de uso de Requests (chamados internos). Camada unica de acesso a
// dados da feature: as rotas so traduzem HTTP <-> servico. Regras de
// transicao ficam em lib/requests/transitions (puro); auditoria em
// lib/requests/activity (puro); arquivos em services/storage (Spaces).

const crypto = require('crypto');
const path = require('path');

const prisma = require('../../lib/prisma');
const { validateChange } = require('../../lib/requests/transitions');
const { diffToActivities } = require('../../lib/requests/activity');
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

async function loadRequestOrFail(id) {
	const request = await prisma.request.findUnique({ where: { id } });
	if (!request) throw RequestServiceError.notFound();
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

function listRequests() {
	// Sem filtro server-side: volume baixo, filtros/KPIs/busca sao client-side
	// (mesmo modelo do CronJobsDashboard).
	return prisma.request.findMany({ orderBy: { createdAt: 'desc' }, include: LIST_INCLUDE });
}

async function getRequestDetail(id) {
	const request = await prisma.request.findUnique({ where: { id }, include: DETAIL_INCLUDE });
	if (!request) throw RequestServiceError.notFound();
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

	// Arquivar tira o chamado dos filtros padrao da tela sem apagar nada.
	// So Completed/Closed podem ser arquivados; desarquivar e sempre permitido.
	const archivedChanged = patch.archived !== undefined
		&& Boolean(current.archivedAt) !== patch.archived;
	if (archivedChanged) {
		const effectiveStatus = applied.status || current.status;
		if (patch.archived && !['Completed', 'Closed'].includes(effectiveStatus)) {
			throw RequestServiceError.conflict(
				'ARCHIVE_ONLY_DONE',
				'Only Completed or Closed requests can be archived'
			);
		}
		applied.archivedAt = patch.archived ? new Date() : null;
	}

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
			action: patch.archived ? 'archived' : 'unarchived',
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
				data: { request_id: id, author_id: user.id, body: commentBody, internal: false },
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
	if (!request) throw RequestServiceError.notFound();
	if (request.trelloCardId) {
		throw RequestServiceError.conflict('CARD_EXISTS', 'A Trello card is already linked to this request');
	}

	let card;
	try {
		card = await trelloService.createCardForRequest(request);
	} catch (error) {
		if (TRELLO_CONFLICT_CODES.has(error.code)) {
			throw RequestServiceError.conflict(error.code, error.message);
		}
		throw error;
	}

	await prisma.$transaction([
		prisma.request.update({
			where: { id },
			data: { trelloCardId: card.cardId, trelloCardUrl: card.cardUrl },
		}),
		prisma.requestActivity.create({
			data: {
				request_id: id,
				actor_id: user.id,
				action: 'trello_card_created',
				field: 'trello',
				newValue: card.cardUrl,
			},
		}),
	]);

	return getRequestDetail(id);
}

// Auto-create na transicao para Assigned. Fire-and-forget: nunca lanca.
// Integracao desligada / card ja existente sao silenciosos; assignee sem
// board vira 'trello_card_skipped' e falha real (credencial revogada, API
// fora) vira 'trello_card_failed' — ambos visiveis no activity log.
function autoCreateTrelloCard({ user, id }) {
	ensureTrelloCard({ user, id }).catch(async (error) => {
		if (error.code === 'TRELLO_NOT_CONFIGURED' || error.code === 'CARD_EXISTS') return;
		const action = (error.code === 'TRELLO_NO_ASSIGNEE' || error.code === 'TRELLO_NO_BOARD_FOR_USER')
			? 'trello_card_skipped'
			: 'trello_card_failed';
		console.error(`Trello card ${action} for request ${id}:`, error.message);
		await prisma.requestActivity.create({
			data: { request_id: id, actor_id: user.id, action, field: 'trello', newValue: error.message },
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

// --- comentarios ----------------------------------------------------------------

async function addComment({ user, id, body, internal }) {
	await loadRequestOrFail(id);
	return prisma.$transaction(async (tx) => {
		const comment = await tx.requestComment.create({
			data: { request_id: id, author_id: user.id, body, internal: Boolean(internal) },
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
		where: { id: attachmentId, request_id: id },
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
		where: { id: attachmentId, request_id: id },
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
	getAttachmentDownload,
	removeAttachment,
	ensureTrelloCard,
};
