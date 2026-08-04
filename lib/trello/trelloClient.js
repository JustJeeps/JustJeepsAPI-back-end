// Client HTTP da API do Trello (https://api.trello.com/1). O axios entra por
// parametro (mesmo padrao do prisma injetado em lib/reports/requestsDigest.js)
// para os testes rodarem sem rede. key/token SEMPRE em params — nunca na URL,
// para nao vazarem em logs de erro do axios.
//
// Erros sao lancados com .code tipado para a camada de servico mapear:
//   TRELLO_AUTH_FAILED   401 (key/token invalidos ou revogados)
//   TRELLO_RATE_LIMITED  429
//   TRELLO_UNAVAILABLE   timeout / 5xx / rede

const axios = require('axios');

const TRELLO_API_BASE = 'https://api.trello.com/1';
const TRELLO_API_TIMEOUT_MS = 15000;

function toTrelloError(error) {
	const status = error.response?.status;
	const wrapped = new Error(
		status === 401
			? 'Trello rejected the credentials (invalid or revoked key/token)'
			: status === 429
				? 'Trello rate limit reached — try again in a few seconds'
				: `Trello API unavailable (${status || error.code || 'network error'})`
	);
	wrapped.code = status === 401 ? 'TRELLO_AUTH_FAILED' : status === 429 ? 'TRELLO_RATE_LIMITED' : 'TRELLO_UNAVAILABLE';
	return wrapped;
}

function createTrelloClient({ http = axios } = {}) {
	const get = async (path, credentials, extraParams = {}) => {
		try {
			const response = await http.get(`${TRELLO_API_BASE}${path}`, {
				params: { key: credentials.apiKey, token: credentials.apiToken, ...extraParams },
				timeout: TRELLO_API_TIMEOUT_MS,
			});
			return response.data;
		} catch (error) {
			throw toTrelloError(error);
		}
	};

	return {
		// Valida a credencial e devolve o dono do token.
		async validateToken({ apiKey, apiToken }) {
			const member = await get(`/tokens/${apiToken}/member`, { apiKey, apiToken });
			return { username: member.username, fullName: member.fullName };
		},

		// Boards visiveis para a conta do token (para o dropdown do painel).
		async listBoards(credentials) {
			const boards = await get('/members/me/boards', credentials, { fields: 'id,name,url' });
			return boards.map((board) => ({ id: board.id, name: board.name, url: board.url }));
		},

		// Listas de um board (destino do card).
		async listBoardLists(credentials, boardId) {
			const lists = await get(`/boards/${boardId}/lists`, credentials, { fields: 'id,name' });
			return lists.map((list) => ({ id: list.id, name: list.name }));
		},

		// Cria o card e devolve { cardId, cardUrl }.
		async createCard(credentials, { idList, name, desc }) {
			try {
				const response = await http.post(`${TRELLO_API_BASE}/cards`, null, {
					params: { key: credentials.apiKey, token: credentials.apiToken, idList, name, desc, pos: 'top' },
					timeout: TRELLO_API_TIMEOUT_MS,
				});
				return { cardId: response.data.id, cardUrl: response.data.shortUrl || response.data.url };
			} catch (error) {
				throw toTrelloError(error);
			}
		},
	};
}

module.exports = { createTrelloClient, TRELLO_API_BASE };
