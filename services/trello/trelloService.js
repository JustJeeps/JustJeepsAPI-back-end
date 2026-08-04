// Integracao one-way com o Trello: cria um card quando o request e atribuido.
// Sem sync bidirecional. A configuracao vive 100% no banco (TrelloSettings +
// TrelloUserBoard), gravada pelo painel /settings — nao existem mais envs
// TRELLO_*. O card vai para o board/lista do ASSIGNEE do request; assignee
// sem board mapeado nao gera card (o servico registra o motivo no activity).
//
// Credenciais sao cacheadas em memoria (TTL 30s) e invalidadas em todo save
// do trelloSettingsService — instancia unica em producao, o TTL e so um teto
// de staleness caso um dia haja replicas.

const prisma = require('../../lib/prisma');
const { createTrelloClient } = require('../../lib/trello/trelloClient');
const { readSettings, isConfigured, readUserBoard } = require('../../lib/trello/settings');
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
		`Project: ${request.project}`,
		`Type: ${request.type}`,
		`Requester: ${requesterName}`,
		`Pricing Tool: ${appUrl}/requests?open=${request.id}`,
	].join('\n');
	return { name: `REQ-${request.id} — ${request.title}`, desc };
}

// Cria o card no board do assignee e devolve { cardId, cardUrl }. Lanca erro
// com .code para a camada de servico mapear: TRELLO_NOT_CONFIGURED,
// TRELLO_NO_ASSIGNEE, TRELLO_NO_BOARD_FOR_USER, TRELLO_AUTH_FAILED,
// TRELLO_RATE_LIMITED, TRELLO_UNAVAILABLE.
async function createCardForRequest(request) {
	const settings = await getSettings();
	if (!isConfigured(settings)) {
		const error = new Error('Trello integration is not configured (set credentials in Settings)');
		error.code = 'TRELLO_NOT_CONFIGURED';
		throw error;
	}

	const mapping = request.assignee_id ? await readUserBoard(prisma, request.assignee_id) : null;
	const destination = resolveCardDestination({ request, mapping });
	if (!destination.ok) {
		const error = new Error(destination.reason);
		error.code = destination.code;
		throw error;
	}

	const appUrl = String(process.env.PRICING_TOOL_URL || 'https://pricingtool.justjeeps.com').replace(/\/+$/, '');
	const { name, desc } = buildCardPayload(request, appUrl);

	return trelloClient.createCard(
		{ apiKey: settings.apiKey, apiToken: settings.apiToken },
		{ idList: destination.listId, name, desc }
	);
}

module.exports = {
	isConfigured: isConfiguredNow,
	createCardForRequest,
	invalidateSettingsCache,
	// exports para teste
	buildCardPayload,
};
