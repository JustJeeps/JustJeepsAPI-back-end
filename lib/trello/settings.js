// Persistencia da configuracao Trello (credencial global + board por usuario).
// Prisma entra por parametro (padrao de lib/reports/requestsDigest.js) — tudo
// testavel com stub, sem Postgres. O apiToken fica em plaintext no DB (decisao
// documentada no schema), mas NUNCA sai daqui sem mascara: toda resposta de
// API passa por redactSettings().

const SETTINGS_ID = 1;
const MASK_PREFIX = '••••'; // ••••

function maskToken(token) {
	if (!token) return null;
	return `${MASK_PREFIX}${String(token).slice(-4)}`;
}

// Token vindo do front comecando com a mascara = "nao alterado".
function isMaskedToken(token) {
	return typeof token === 'string' && token.startsWith('•');
}

async function readSettings(prisma) {
	return prisma.trelloSettings.findUnique({ where: { id: SETTINGS_ID } });
}

// apiToken undefined (ou mascarado) mantem o token atual; apiKey sempre grava.
async function writeSettings(prisma, { apiKey, apiToken, updatedById }) {
	const keepToken = apiToken === undefined || apiToken === null || isMaskedToken(apiToken);
	return prisma.trelloSettings.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, apiKey, apiToken: keepToken ? null : apiToken, updatedById },
		update: { apiKey, ...(keepToken ? {} : { apiToken }), updatedById },
	});
}

async function clearSettings(prisma) {
	return prisma.trelloSettings.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, apiKey: null, apiToken: null },
		update: { apiKey: null, apiToken: null },
	});
}

function isConfigured(settings) {
	return Boolean(settings?.apiKey && settings?.apiToken);
}

// Shape seguro para respostas HTTP — o token completo nunca sai.
function redactSettings(settings) {
	return {
		configured: isConfigured(settings),
		apiKey: settings?.apiKey || null,
		apiTokenMasked: maskToken(settings?.apiToken),
		updatedAt: settings?.updatedAt || null,
	};
}

async function readUserBoard(prisma, userId) {
	return prisma.trelloUserBoard.findUnique({ where: { userId } });
}

async function listUserBoards(prisma) {
	return prisma.trelloUserBoard.findMany({ orderBy: { userId: 'asc' } });
}

// boardId null remove o mapeamento (usuario fica "sem board").
async function writeUserBoard(prisma, { userId, boardId, boardName, listId, listName }) {
	if (!boardId) {
		await prisma.trelloUserBoard.deleteMany({ where: { userId } });
		return null;
	}
	return prisma.trelloUserBoard.upsert({
		where: { userId },
		create: { userId, boardId, boardName, listId, listName },
		update: { boardId, boardName, listId, listName },
	});
}

// Boards por setor (2026-08-11): mesmo contrato do trio de user-board, com a
// chave trocada para sectorId — o card vai para o board do SETOR do chamado.
// O trio de user-board acima fica dormente ate a migration de limpeza.
async function readSectorBoard(prisma, sectorId) {
	return prisma.trelloSectorBoard.findUnique({ where: { sectorId } });
}

async function listSectorBoards(prisma) {
	return prisma.trelloSectorBoard.findMany({ orderBy: { sectorId: 'asc' } });
}

// boardId null remove o mapeamento (setor fica "sem board").
async function writeSectorBoard(prisma, { sectorId, boardId, boardName, listId, listName }) {
	if (!boardId) {
		await prisma.trelloSectorBoard.deleteMany({ where: { sectorId } });
		return null;
	}
	return prisma.trelloSectorBoard.upsert({
		where: { sectorId },
		create: { sectorId, boardId, boardName, listId, listName },
		update: { boardId, boardName, listId, listName },
	});
}

module.exports = {
	SETTINGS_ID,
	maskToken,
	isMaskedToken,
	readSettings,
	writeSettings,
	clearSettings,
	isConfigured,
	redactSettings,
	readUserBoard,
	listUserBoards,
	writeUserBoard,
	readSectorBoard,
	listSectorBoards,
	writeSectorBoard,
};
