// Coleta os dados do digest de Requests (chamados internos): novas
// solicitacoes e atualizacoes desde o ultimo envio (watermark no SyncState),
// mais o retrato atual de unassigned e aging. O prisma entra por parametro
// para o modulo ser testavel com stub.

const WATERMARK_KEY = 'requests-digest-last-run';
const DAY_MS = 24 * 60 * 60 * 1000;
const AGING_DAYS = 7;

const USER_SELECT = { id: true, username: true, firstname: true, lastname: true };
const REQUEST_INCLUDE = {
	requester: { select: USER_SELECT },
	assignee: { select: USER_SELECT },
};

async function readDigestWatermark(prisma) {
	const row = await prisma.syncState.findUnique({ where: { key: WATERMARK_KEY } });
	if (!row || !row.value) return null;
	const date = new Date(row.value);
	return Number.isNaN(date.getTime()) ? null : date;
}

async function saveDigestWatermark(prisma, date) {
	const value = date.toISOString();
	await prisma.syncState.upsert({
		where: { key: WATERMARK_KEY },
		update: { value },
		create: { key: WATERMARK_KEY, value },
	});
}

async function collectRequestsDigestData(prisma, { since = null, now = new Date() } = {}) {
	// Primeiro envio (sem watermark): janela de 24h para nao despejar o
	// historico inteiro no e-mail.
	const windowStart = since || new Date(now.getTime() - DAY_MS);
	const agingCutoff = new Date(now.getTime() - AGING_DAYS * DAY_MS);

	const [newRequests, updates, unassigned, aging] = await Promise.all([
		prisma.request.findMany({
			where: { createdAt: { gt: windowStart } },
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'desc' },
		}),
		prisma.requestActivity.findMany({
			// Entradas "created" ja aparecem na secao de novas solicitacoes.
			where: { createdAt: { gt: windowStart }, action: { not: 'created' } },
			include: {
				actor: { select: USER_SELECT },
				request: { select: { id: true, title: true, status: true } },
			},
			orderBy: { createdAt: 'desc' },
		}),
		// Arquivado sai das duas secoes de pendencia: sem isso um chamado
		// Completed (que nao e "Closed") e arquivado ficaria eternamente na
		// lista de unassigned/aging do e-mail.
		prisma.request.findMany({
			where: { assignee_id: null, status: { not: 'Closed' }, archivedAt: null },
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'asc' },
		}),
		prisma.request.findMany({
			where: { status: { notIn: ['Closed'] }, updatedAt: { lt: agingCutoff }, archivedAt: null },
			include: REQUEST_INCLUDE,
			orderBy: { updatedAt: 'asc' },
		}),
	]);

	return { windowStart, now, newRequests, updates, unassigned, aging };
}

module.exports = {
	WATERMARK_KEY,
	readDigestWatermark,
	saveDigestWatermark,
	collectRequestsDigestData,
};
