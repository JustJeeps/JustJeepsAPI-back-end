const test = require('node:test');
const assert = require('node:assert');

const { createTrelloClient, TRELLO_API_BASE } = require('../../lib/trello/trelloClient.js');

// axios entra por parametro — stub que grava as chamadas, nenhuma rede.

const makeHttpStub = ({ getImpl, postImpl, putImpl } = {}) => {
	const calls = { get: [], post: [], put: [] };
	return {
		calls,
		get: async (url, config) => {
			calls.get.push({ url, config });
			if (getImpl) return getImpl(url, config);
			return { data: [] };
		},
		post: async (url, body, config) => {
			calls.post.push({ url, body, config });
			if (postImpl) return postImpl(url, body, config);
			return { data: {} };
		},
		put: async (url, body, config) => {
			calls.put.push({ url, body, config });
			if (putImpl) return putImpl(url, body, config);
			return { data: {} };
		},
	};
};

const CREDS = { apiKey: 'the-key', apiToken: 'the-token' };

const httpError = (status) => {
	const error = new Error(`Request failed with status ${status}`);
	error.response = { status };
	return error;
};

test('validateToken chama /tokens/{token}/member com key/token em params', async () => {
	const http = makeHttpStub({
		getImpl: async () => ({ data: { username: 'webdev', fullName: 'Web Dev' } }),
	});
	const client = createTrelloClient({ http });
	const member = await client.validateToken(CREDS);

	assert.deepStrictEqual(member, { username: 'webdev', fullName: 'Web Dev' });
	const call = http.calls.get[0];
	assert.strictEqual(call.url, `${TRELLO_API_BASE}/tokens/the-token/member`);
	assert.strictEqual(call.config.params.key, 'the-key');
	assert.strictEqual(call.config.params.token, 'the-token');
});

test('listBoards e listBoardLists usam os endpoints certos e filtram campos', async () => {
	const http = makeHttpStub({
		getImpl: async (url) => {
			if (url.includes('/members/me/boards')) {
				return { data: [{ id: 'b1', name: 'Board 1', url: 'https://trello.com/b/b1', extra: 'x' }] };
			}
			return { data: [{ id: 'l1', name: 'To Do', pos: 1 }] };
		},
	});
	const client = createTrelloClient({ http });

	const boards = await client.listBoards(CREDS);
	assert.deepStrictEqual(boards, [{ id: 'b1', name: 'Board 1', url: 'https://trello.com/b/b1' }]);
	assert.strictEqual(http.calls.get[0].url, `${TRELLO_API_BASE}/members/me/boards`);

	const lists = await client.listBoardLists(CREDS, 'b1');
	assert.deepStrictEqual(lists, [{ id: 'l1', name: 'To Do' }]);
	assert.strictEqual(http.calls.get[1].url, `${TRELLO_API_BASE}/boards/b1/lists`);
});

test('createCard envia POST /cards com params e devolve cardId/cardUrl', async () => {
	const http = makeHttpStub({
		postImpl: async () => ({ data: { id: 'card1', shortUrl: 'https://trello.com/c/abc' } }),
	});
	const client = createTrelloClient({ http });
	const card = await client.createCard(CREDS, { idList: 'l1', name: 'REQ-7 — Fix', desc: 'body' });

	assert.deepStrictEqual(card, { cardId: 'card1', cardUrl: 'https://trello.com/c/abc' });
	const call = http.calls.post[0];
	assert.strictEqual(call.url, `${TRELLO_API_BASE}/cards`);
	assert.strictEqual(call.config.params.idList, 'l1');
	assert.strictEqual(call.config.params.key, 'the-key');
	// key/token vao em params (nunca interpolados na URL logavel)
	assert.ok(!call.url.includes('the-key') && !call.url.includes('the-token'));
});

// Mover card entre boards (2026-08-11, chamado muda de setor): unica operacao
// de EDICAO permitida na integracao — o resto continua create-only.
test('moveCard envia PUT /cards/{id} com idBoard/idList em params', async () => {
	const http = makeHttpStub({
		putImpl: async () => ({ data: { id: 'card1', shortUrl: 'https://trello.com/c/abc' } }),
	});
	const client = createTrelloClient({ http });
	const card = await client.moveCard(CREDS, { cardId: 'card1', idBoard: 'b2', idList: 'l9' });

	assert.deepStrictEqual(card, { cardId: 'card1', cardUrl: 'https://trello.com/c/abc' });
	const call = http.calls.put[0];
	assert.strictEqual(call.url, `${TRELLO_API_BASE}/cards/card1`);
	assert.strictEqual(call.config.params.idBoard, 'b2');
	assert.strictEqual(call.config.params.idList, 'l9');
	assert.strictEqual(call.config.params.key, 'the-key');
	assert.ok(!call.url.includes('the-key') && !call.url.includes('the-token'));
});

test('moveCard: 404 vira TRELLO_CARD_NOT_FOUND (card deletado a mao no Trello)', async () => {
	const http = makeHttpStub({ putImpl: async () => { throw httpError(404); } });
	const client = createTrelloClient({ http });
	await assert.rejects(
		client.moveCard(CREDS, { cardId: 'gone', idBoard: 'b2', idList: 'l9' }),
		(error) => error.code === 'TRELLO_CARD_NOT_FOUND'
	);
});

test('erros HTTP viram codes tipados: 401 auth, 429 rate limit, resto unavailable', async () => {
	for (const [status, code] of [[401, 'TRELLO_AUTH_FAILED'], [429, 'TRELLO_RATE_LIMITED'], [500, 'TRELLO_UNAVAILABLE']]) {
		const http = makeHttpStub({ getImpl: async () => { throw httpError(status); } });
		const client = createTrelloClient({ http });
		await assert.rejects(client.listBoards(CREDS), (error) => error.code === code);
	}

	const timeoutHttp = makeHttpStub({ getImpl: async () => { const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e; } });
	await assert.rejects(
		createTrelloClient({ http: timeoutHttp }).listBoards(CREDS),
		(error) => error.code === 'TRELLO_UNAVAILABLE'
	);
});
