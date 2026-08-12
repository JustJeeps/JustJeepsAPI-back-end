// Casos de uso de Setores (boards por setor da feature Requests). Camada
// unica de acesso a dados dos setores: as rotas so traduzem HTTP <-> servico.
// Regras puras em lib/sectors/permissions (papeis) e lib/sectors/membership
// (guard LAST_ADMIN). Politica: triage global e o "workspace admin" do Trello
// — gerencia todos os setores; admin de setor gerencia so o seu. Erros de
// negocio viram RequestServiceError (409, nunca 403 — convencao da feature).

const prisma = require('../../lib/prisma');
const { roleFor, canManageSector, canCreateSector, slugify } = require('../../lib/sectors/permissions');
const { validateMemberChange } = require('../../lib/sectors/membership');
const { writeSectorBoard, readSectorBoard } = require('../../lib/trello/settings');
const { SECTOR_ROLES, DEFAULT_SECTOR_SLUG, SECTOR_NAME_MAX_LENGTH } = require('../../config/sectors');
const { isTriageUser } = require('../../config/requests');
const { RequestServiceError } = require('../requests/errors');

const USER_SELECT = { id: true, username: true, email: true, firstname: true, lastname: true };

const MEMBERS_INCLUDE = { include: { user: { select: USER_SELECT } }, orderBy: { id: 'asc' } };

// --- helpers -----------------------------------------------------------------

async function loadSectorOrFail(sectorId) {
	const sector = await prisma.sector.findUnique({ where: { id: sectorId } });
	if (!sector) throw RequestServiceError.notFound('Sector not found');
	return sector;
}

async function membershipFor(userId, sectorId) {
	return prisma.sectorMember.findUnique({
		where: { sector_id_user_id: { sector_id: sectorId, user_id: userId } },
	});
}

// Papel efetivo do usuario no setor ('triage' | 'admin' | 'member' | null).
async function roleForSector(user, sectorId) {
	const isTriage = isTriageUser(user.username);
	const membership = isTriage ? null : await membershipFor(user.id, sectorId);
	return roleFor({ membership, isTriage });
}

async function assertCanManageSector(user, sectorId) {
	const role = await roleForSector(user, sectorId);
	if (!canManageSector({ role })) {
		throw RequestServiceError.conflict(
			'NOT_SECTOR_ADMIN',
			'Only this sector\'s admins or a triage user can do that'
		);
	}
	return role;
}

// Ids dos setores em que o usuario e admin (para o front decidir o que
// mostrar e para o gate das rotas de leitura do Trello).
async function adminSectorIdsFor(userId) {
	const rows = await prisma.sectorMember.findMany({
		where: { user_id: userId, role: 'admin' },
		select: { sector_id: true },
	});
	return rows.map((row) => row.sector_id);
}

// Ids de TODOS os setores dos quais o usuario e membro (qualquer papel).
// Base da visibilidade por membership (lib/sectors/visibility.js).
async function memberSectorIdsFor(userId) {
	const rows = await prisma.sectorMember.findMany({
		where: { user_id: userId },
		select: { sector_id: true },
	});
	return rows.map((row) => row.sector_id);
}

async function findDefaultSector() {
	const sector = await prisma.sector.findUnique({ where: { slug: DEFAULT_SECTOR_SLUG } });
	if (!sector) {
		// A migration semeia o General; sumir daqui e estado corrompido.
		throw new Error(`Default sector "${DEFAULT_SECTOR_SLUG}" not found — was the add_sectors migration applied?`);
	}
	return sector;
}

const sectorActivityRow = (sectorId, actorId, action, extra = {}) => ({
	sector_id: sectorId,
	actor_id: actorId,
	action,
	...extra,
});

// --- listagem -----------------------------------------------------------------

// Catalogo PUBLICO dos setores (nomes para tabs e selects de criar/mover):
// qualquer requests user pode ver que os setores existem — e o que permite
// abrir chamado para outro setor. Configuracao (membros, Trello) fica fora.
async function listSectorCatalog() {
	return prisma.sector.findMany({
		select: { id: true, name: true, slug: true, color: true, archivedAt: true },
		orderBy: [{ createdAt: 'asc' }],
	});
}

// Setores com membros e mapping do Trello — isto e CONFIGURACAO (decisao de
// 2026-08-12: member ve o board de chamados, nao a configuracao). Triage ve
// todos; os demais recebem apenas os setores dos quais sao ADMIN. O gate de
// rota (SECTOR_ADMIN_ONLY) barra quem nao e admin de setor nenhum.
async function listSectors({ user } = {}) {
	const adminOnly = user && !isTriageUser(user.username);
	const adminIds = adminOnly ? await adminSectorIdsFor(user.id) : null;
	const [sectors, counts] = await Promise.all([
		prisma.sector.findMany({
			where: adminOnly ? { id: { in: adminIds } } : undefined,
			include: { members: MEMBERS_INCLUDE, trelloBoard: true },
			orderBy: [{ createdAt: 'asc' }],
		}),
		prisma.request.groupBy({
			by: ['sector_id'],
			where: { deletedAt: null },
			_count: { _all: true },
		}),
	]);
	const countBySector = new Map(counts.map((row) => [row.sector_id, row._count._all]));
	return sectors.map((sector) => ({
		...sector,
		requestCount: countBySector.get(sector.id) || 0,
	}));
}

// --- criacao / edicao ----------------------------------------------------------

function cleanSectorName(name) {
	const text = String(name ?? '').trim();
	if (!text) throw RequestServiceError.validation('Sector name is required');
	if (text.length > SECTOR_NAME_MAX_LENGTH) {
		throw RequestServiceError.validation(`Sector name is too long (max ${SECTOR_NAME_MAX_LENGTH} chars)`);
	}
	return text;
}

// Slug unico: base do nome + sufixo numerico em colisao (general, general-2…).
async function uniqueSlugFor(name) {
	const base = slugify(name) || 'sector';
	let candidate = base;
	for (let suffix = 2; await prisma.sector.findUnique({ where: { slug: candidate } }); suffix += 1) {
		candidate = `${base}-${suffix}`;
	}
	return candidate;
}

async function createSector({ user, name, color }) {
	if (!canCreateSector({ isTriage: isTriageUser(user.username) })) {
		throw RequestServiceError.conflict('TRIAGE_ONLY', 'Only triage users can create sectors');
	}
	const cleanName = cleanSectorName(name);
	const slug = await uniqueSlugFor(cleanName);

	const created = await prisma.$transaction(async (tx) => {
		const sector = await tx.sector.create({
			data: { name: cleanName, slug, color: color || null },
		});
		await tx.sectorActivity.create({
			data: sectorActivityRow(sector.id, user.id, 'created', { field: 'name', newValue: cleanName }),
		});
		return sector;
	});
	return getSector(created.id);
}

async function getSector(sectorId) {
	const sector = await prisma.sector.findUnique({
		where: { id: sectorId },
		include: { members: MEMBERS_INCLUDE, trelloBoard: true },
	});
	if (!sector) throw RequestServiceError.notFound('Sector not found');
	return sector;
}

// patch: { name?, color?, archived? }. Rename/cor: triage ou admin do setor.
// Arquivar: General nunca (e o destino default), e so setor sem chamados
// ativos (nao arquivados, nao deletados) — espelho do "archive-only" do plano.
async function updateSector({ user, sectorId, patch }) {
	const sector = await loadSectorOrFail(sectorId);
	await assertCanManageSector(user, sectorId);

	const data = {};
	const activities = [];

	if (patch.name !== undefined) {
		const cleanName = cleanSectorName(patch.name);
		if (cleanName !== sector.name) {
			data.name = cleanName;
			activities.push(sectorActivityRow(sectorId, user.id, 'renamed', {
				field: 'name',
				oldValue: sector.name,
				newValue: cleanName,
			}));
		}
	}

	if (patch.color !== undefined) {
		data.color = patch.color || null;
	}

	if (patch.archived !== undefined) {
		const wantArchived = Boolean(patch.archived);
		const isArchived = Boolean(sector.archivedAt);
		if (wantArchived !== isArchived) {
			if (wantArchived) {
				if (sector.slug === DEFAULT_SECTOR_SLUG) {
					throw RequestServiceError.conflict('DEFAULT_SECTOR', 'The General sector cannot be archived');
				}
				const activeRequests = await prisma.request.count({
					where: { sector_id: sectorId, deletedAt: null, archivedAt: null },
				});
				if (activeRequests > 0) {
					throw RequestServiceError.conflict(
						'SECTOR_NOT_EMPTY',
						`This sector still has ${activeRequests} active request(s) — move or archive them first`
					);
				}
			}
			data.archivedAt = wantArchived ? new Date() : null;
			activities.push(sectorActivityRow(sectorId, user.id, wantArchived ? 'archived' : 'unarchived', {
				field: 'archived',
			}));
		}
	}

	if (!Object.keys(data).length) throw RequestServiceError.validation('Nothing to update');

	await prisma.$transaction(async (tx) => {
		await tx.sector.update({ where: { id: sectorId }, data });
		if (activities.length) await tx.sectorActivity.createMany({ data: activities });
	});
	return getSector(sectorId);
}

// --- membros -------------------------------------------------------------------

// Adiciona ou muda o papel de um membro. Guard LAST_ADMIN em lib pura; bypass
// de triage e logado no metadata da activity (auditavel, padrao do plano).
async function setMember({ user, sectorId, userId, role }) {
	await loadSectorOrFail(sectorId);
	await assertCanManageSector(user, sectorId);
	if (!SECTOR_ROLES.includes(role)) throw RequestServiceError.validation('Invalid role');

	const target = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
	if (!target) throw RequestServiceError.validation('User not found');

	const members = await prisma.sectorMember.findMany({ where: { sector_id: sectorId } });
	const existing = members.find((member) => member.user_id === userId);
	if (existing && existing.role === role) return getSector(sectorId);

	const verdict = validateMemberChange({
		members,
		change: { userId, role },
		actorIsTriage: isTriageUser(user.username),
	});
	if (!verdict.ok) throw RequestServiceError.conflict(verdict.error.code, verdict.error.message);

	const activity = sectorActivityRow(sectorId, user.id, existing ? 'role_change' : 'member_added', {
		field: 'members',
		oldValue: existing ? `${target.username} (${existing.role})` : null,
		newValue: `${target.username} (${role})`,
		...(verdict.bypassed ? { metadata: { lastAdminBypass: true } } : {}),
	});

	await prisma.$transaction(async (tx) => {
		await tx.sectorMember.upsert({
			where: { sector_id_user_id: { sector_id: sectorId, user_id: userId } },
			create: { sector_id: sectorId, user_id: userId, role },
			update: { role },
		});
		await tx.sectorActivity.create({ data: activity });
	});
	return getSector(sectorId);
}

async function removeMember({ user, sectorId, userId }) {
	await loadSectorOrFail(sectorId);
	await assertCanManageSector(user, sectorId);

	const members = await prisma.sectorMember.findMany({ where: { sector_id: sectorId } });
	const existing = members.find((member) => member.user_id === userId);
	if (!existing) throw RequestServiceError.validation('User is not a member of this sector');

	const verdict = validateMemberChange({
		members,
		change: { userId, remove: true },
		actorIsTriage: isTriageUser(user.username),
	});
	if (!verdict.ok) throw RequestServiceError.conflict(verdict.error.code, verdict.error.message);

	const target = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
	const activity = sectorActivityRow(sectorId, user.id, 'member_removed', {
		field: 'members',
		oldValue: `${target?.username || userId} (${existing.role})`,
		...(verdict.bypassed ? { metadata: { lastAdminBypass: true } } : {}),
	});

	await prisma.$transaction(async (tx) => {
		await tx.sectorMember.delete({ where: { id: existing.id } });
		await tx.sectorActivity.create({ data: activity });
	});
	return getSector(sectorId);
}

// --- mapping Trello -------------------------------------------------------------

// Board/lista do Trello do setor. Mesmo contrato do antigo saveUserBoard:
// boardId null remove o mapeamento. Triage ou admin do setor.
async function saveSectorTrelloBoard({ user, sectorId, boardId, boardName, listId, listName }) {
	await loadSectorOrFail(sectorId);
	await assertCanManageSector(user, sectorId);

	const previous = await readSectorBoard(prisma, sectorId);

	let saved = null;
	if (!boardId) {
		await writeSectorBoard(prisma, { sectorId, boardId: null });
	} else {
		const clean = (value, label) => {
			const text = String(value ?? '').trim();
			if (!text) throw RequestServiceError.validation(`${label} is required`);
			return text;
		};
		saved = await writeSectorBoard(prisma, {
			sectorId,
			boardId: clean(boardId, 'boardId'),
			boardName: clean(boardName, 'boardName'),
			listId: clean(listId, 'listId'),
			listName: clean(listName, 'listName'),
		});
	}

	const label = (mapping) => (mapping ? `${mapping.boardName} / ${mapping.listName}` : null);
	await prisma.sectorActivity.create({
		data: sectorActivityRow(sectorId, user.id, 'trello_board_change', {
			field: 'trello',
			oldValue: label(previous),
			newValue: label(saved),
		}),
	});
	return saved;
}

// --- audit ---------------------------------------------------------------------

async function getSectorActivity({ user, sectorId }) {
	await loadSectorOrFail(sectorId);
	await assertCanManageSector(user, sectorId);
	return prisma.sectorActivity.findMany({
		where: { sector_id: sectorId },
		include: { actor: { select: USER_SELECT } },
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take: 200,
	});
}

module.exports = {
	listSectorCatalog,
	listSectors,
	getSector,
	createSector,
	updateSector,
	setMember,
	removeMember,
	saveSectorTrelloBoard,
	getSectorActivity,
	// compartilhados com requestsService / rotas
	findDefaultSector,
	membershipFor,
	roleForSector,
	adminSectorIdsFor,
	memberSectorIdsFor,
	loadSectorOrFail,
};
