// Integracao com o Trello: cria um card quando o request e atribuido e MOVE o
// card quando o chamado muda de setor (unica operacao de edicao — o resto
// continua one-way, sem sync de volta). A configuracao vive 100% no banco
// (TrelloSettings + TrelloSectorBoard), gravada pelo painel /settings — nao
// existem mais envs TRELLO_*. O card vai para o board/lista do SETOR do
// chamado (boards por setor, 2026-08-11 — antes era o board do assignee);
// setor sem board mapeado nao gera card (o servico registra o motivo).
//
// Credenciais sao cacheadas em memoria (TTL 30s) e invalidadas em todo save
// do trelloSettingsService — instancia unica em producao, o TTL e so um teto
// de staleness caso um dia haja replicas.

const prisma = require('../../lib/prisma');
const { createTrelloClient } = require('../../lib/trello/trelloClient');
const { readSettings, isConfigured, readSectorBoard } = require('../../lib/trello/settings');
const { resolveCardDestination } = require('../../lib/trello/resolveDestination');

const SETTINGS_CACHE_TTL_MS = 30_000;

const trelloClient = createTrelloClient();

let settingsCache = { settings: null, at: 0 };

async function getSettings() {
	if (Date.now() - settingsCache.at > SETTINGS_CACHE_TTL_MS) {
		settingsCache = { settings: await readSettings(prisma), at: Date.now() };
	}
	return settingsCache.settings;
}

function invalidateSettingsCache() {
	settingsCache = { settings: null, at: 0 };
}

async function isConfiguredNow() {
	return isConfigured(await getSettings());
}

function buildCardPayload(request, appUrl) {
	const requesterName = request.requester?.username || 'unknown';
	const desc = [
		request.description,
		'',
		'—',
		`Priority: ${request.priority}`,
		...(request.sector?.name ? [`Sector: ${request.sector.name}`] : []),
		`Project: ${request.project}`,
		`Type: ${request.type}`,
		`Requester: ${requesterName}`,
		`Pricing Tool: ${appUrl}/requests?open=${request.id}`,
	].join('\n');
	return { name: `REQ-${request.id} — ${request.title}`, desc };
}

// Credencial + destino do setor, compartilhado por criar e mover. Lanca erro
// com .code: TRELLO_NOT_CONFIGURED, TRELLO_NO_BOARD_FOR_SECTOR.
async function resolveConfiguredDestination(request) {
	const settings = await getSettings();
	if (!isConfigured(settings)) {
		const error = new Error('Trello integration is not configured (set credentials in Settings)');
		error.code = 'TRELLO_NOT_CONFIGURED';
		throw error;
	}

	const sectorMapping = await readSectorBoard(prisma, request.sector_id);
	const destination = resolveCardDestination({ request, sectorMapping });
	if (!destination.ok) {
		const error = new Error(destination.reason);
		error.code = destination.code;
		throw error;
	}

	return { settings, destination };
}

// Cria o card no board do setor e devolve { cardId, cardUrl }. Codes possiveis
// alem dos de resolveConfiguredDestination: TRELLO_AUTH_FAILED,
// TRELLO_RATE_LIMITED, TRELLO_UNAVAILABLE.
async function createCardForRequest(request) {
	const { settings, destination } = await resolveConfiguredDestination(request);

	const appUrl = String(process.env.PRICING_TOOL_URL || 'https://pricingtool.justjeeps.com').replace(/\/+$/, '');
	const { name, desc } = buildCardPayload(request, appUrl);

	return trelloClient.createCard(
		{ apiKey: settings.apiKey, apiToken: settings.apiToken },
		{ idList: destination.listId, name, desc }
	);
}

// Move o card existente para o board/lista do setor ATUAL do request (chamado
// mudou de setor). Devolve { cardId, cardUrl, boardId, boardName }. Codes
// extras: TRELLO_CARD_NOT_FOUND (card deletado a mao no Trello).
async function moveCardForRequest(request) {
	const { settings, destination } = await resolveConfiguredDestination(request);

	const moved = await trelloClient.moveCard(
		{ apiKey: settings.apiKey, apiToken: settings.apiToken },
		{ cardId: request.trelloCardId, idBoard: destination.boardId, idList: destination.listId }
	);
	return { ...moved, boardId: destination.boardId };
}

module.exports = {
	isConfigured: isConfiguredNow,
	createCardForRequest,
	moveCardForRequest,
	invalidateSettingsCache,
	// exports para teste
	buildCardPayload,
};
