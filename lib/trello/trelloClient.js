// Client HTTP da API do Trello (https://api.trello.com/1). O axios entra por
// parametro (mesmo padrao do prisma injetado em lib/reports/requestsDigest.js)
// para os testes rodarem sem rede. key/token SEMPRE em params — nunca na URL,
// para nao vazarem em logs de erro do axios.
//
// Erros sao lancados com .code tipado para a camada de servico mapear:
//   TRELLO_AUTH_FAILED     401 (key/token invalidos ou revogados)
//   TRELLO_CARD_NOT_FOUND  404 em operacao SOBRE um card (deletado a mao no
//                          Trello) — um 404 fora disso (board/lista removidos)
//                          continua TRELLO_UNAVAILABLE, senao o create diria
//                          "card not found" de um card que nunca existiu
//   TRELLO_RATE_LIMITED    429
//   TRELLO_UNAVAILABLE     timeout / 5xx / rede

const axios = require('axios');

const TRELLO_API_BASE = 'https://api.trello.com/1';
const TRELLO_API_TIMEOUT_MS = 15000;

function toTrelloError(error, { cardNotFoundOn404 = false } = {}) {
	const status = error.response?.status;
	let code = 'TRELLO_UNAVAILABLE';
	let message = `Trello API unavailable (${status || error.code || 'network error'})`;
	if (status === 401) {
		code = 'TRELLO_AUTH_FAILED';
		message = 'Trello rejected the credentials (invalid or revoked key/token)';
	} else if (status === 404 && cardNotFoundOn404) {
		code = 'TRELLO_CARD_NOT_FOUND';
		message = 'Trello card not found (was it deleted in Trello?)';
	} else if (status === 429) {
		code = 'TRELLO_RATE_LIMITED';
		message = 'Trello rate limit reached — try again in a few seconds';
	}
	const wrapped = new Error(message);
	wrapped.code = code;
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
			const member = await get(`/tokens/${encodeURIComponent(apiToken)}/member`, { apiKey, apiToken });
			return { username: member.username, fullName: member.fullName };
		},

		// Boards visiveis para a conta do token (para o dropdown do painel).
		async listBoards(credentials) {
			const boards = await get('/members/me/boards', credentials, { fields: 'id,name,url' });
			return boards.map((board) => ({ id: board.id, name: board.name, url: board.url }));
		},

		// Listas de um board (destino do card).
		async listBoardLists(credentials, boardId) {
			const lists = await get(`/boards/${encodeURIComponent(boardId)}/lists`, credentials, { fields: 'id,name' });
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

		// Move o card para outro board/lista (chamado mudou de setor). Unica
		// operacao de EDICAO da integracao — o resto continua create-only.
		async moveCard(credentials, { cardId, idBoard, idList }) {
			try {
				const response = await http.put(`${TRELLO_API_BASE}/cards/${encodeURIComponent(cardId)}`, null, {
					params: { key: credentials.apiKey, token: credentials.apiToken, idBoard, idList, pos: 'top' },
					timeout: TRELLO_API_TIMEOUT_MS,
				});
				return { cardId: response.data.id, cardUrl: response.data.shortUrl || response.data.url };
			} catch (error) {
				// Unica operacao dirigida a um card existente: aqui (e so aqui)
				// um 404 significa "o card sumiu".
				throw toTrelloError(error, { cardNotFoundOn404: true });
			}
		},
	};
}

module.exports = { createTrelloClient, TRELLO_API_BASE };
