// Casos de uso da configuracao Trello (painel /settings, so triage). Liga
// lib/trello/settings (persistencia) e lib/trello/trelloClient (API) ao
// prisma/axios reais. Toda resposta passa por redactSettings — o token
// completo nunca sai da API. Erros de negocio viram RequestServiceError
// (409, nunca 403 — mesma convencao da feature Requests).

const prisma = require('../../lib/prisma');
const { createTrelloClient } = require('../../lib/trello/trelloClient');
const {
	readSettings,
	writeSettings,
	clearSettings,
	isConfigured,
	redactSettings,
	isMaskedToken,
	listUserBoards,
	writeUserBoard,
} = require('../../lib/trello/settings');
const { invalidateSettingsCache } = require('./trelloService');
const { RequestServiceError } = require('../requests/errors');

const trelloClient = createTrelloClient();

const trelloError = (error) =>
	error.code?.startsWith?.('TRELLO_')
		? RequestServiceError.conflict(error.code, error.message)
		: error;

async function getCredentialsOrThrow() {
	const settings = await readSettings(prisma);
	if (!isConfigured(settings)) {
		throw RequestServiceError.conflict(
			'TRELLO_NOT_CONFIGURED',
			'Trello integration is not configured (set credentials in Settings)'
		);
	}
	return { apiKey: settings.apiKey, apiToken: settings.apiToken };
}

async function getSettingsRedacted() {
	return redactSettings(await readSettings(prisma));
}

async function saveSettings({ user, apiKey, apiToken }) {
	const key = String(apiKey ?? '').trim();
	if (!key) throw RequestServiceError.validation('API key is required');

	// Token mascarado/omitido = mantem o atual; mas exige que exista um.
	const token = apiToken === undefined || apiToken === null ? undefined : String(apiToken).trim();
	if (token !== undefined && token === '') throw RequestServiceError.validation('API token cannot be empty');
	if (token === undefined || isMaskedToken(token)) {
		const current = await readSettings(prisma);
		if (!current?.apiToken) throw RequestServiceError.validation('API token is required');
	}

	await writeSettings(prisma, { apiKey: key, apiToken: token, updatedById: user.id });
	invalidateSettingsCache();
	return getSettingsRedacted();
}

async function disableIntegration() {
	await clearSettings(prisma);
	invalidateSettingsCache();
}

// Testa credenciais do body (form ainda nao salvo) ou as salvas.
async function testConnection({ apiKey, apiToken } = {}) {
	let credentials;
	if (apiKey && apiToken && !isMaskedToken(apiToken)) {
		credentials = { apiKey: String(apiKey).trim(), apiToken: String(apiToken).trim() };
	} else {
		credentials = await getCredentialsOrThrow();
	}
	try {
		const member = await trelloClient.validateToken(credentials);
		return { ok: true, member };
	} catch (error) {
		throw trelloError(error);
	}
}

async function listBoards() {
	const credentials = await getCredentialsOrThrow();
	try {
		return await trelloClient.listBoards(credentials);
	} catch (error) {
		throw trelloError(error);
	}
}

async function listBoardLists(boardId) {
	const credentials = await getCredentialsOrThrow();
	try {
		return await trelloClient.listBoardLists(credentials, boardId);
	} catch (error) {
		throw trelloError(error);
	}
}

async function getUserBoards() {
	return listUserBoards(prisma);
}

async function saveUserBoard({ userId, boardId, boardName, listId, listName }) {
	if (!boardId) {
		await writeUserBoard(prisma, { userId, boardId: null });
		return null;
	}
	const clean = (value, label) => {
		const text = String(value ?? '').trim();
		if (!text) throw RequestServiceError.validation(`${label} is required`);
		return text;
	};
	return writeUserBoard(prisma, {
		userId,
		boardId: clean(boardId, 'boardId'),
		boardName: clean(boardName, 'boardName'),
		listId: clean(listId, 'listId'),
		listName: clean(listName, 'listName'),
	});
}

module.exports = {
	getSettingsRedacted,
	saveSettings,
	disableIntegration,
	testConnection,
	listBoards,
	listBoardLists,
	getUserBoards,
	saveUserBoard,
};
