const test = require('node:test');
const assert = require('node:assert');

const {
	maskToken,
	isMaskedToken,
	writeSettings,
	isConfigured,
	redactSettings,
	writeUserBoard,
	readSectorBoard,
	listSectorBoards,
	writeSectorBoard,
} = require('../../lib/trello/settings.js');

// Prisma entra por parametro — stub direto, nenhum contato com o Postgres
// (o .env local aponta para producao).

const makePrismaStub = () => {
	let settingsRow = null;
	const userBoards = new Map();
	const sectorBoards = new Map();
	return {
		get settingsRow() { return settingsRow; },
		get userBoards() { return userBoards; },
		get sectorBoards() { return sectorBoards; },
		trelloSettings: {
			findUnique: async () => settingsRow,
			upsert: async ({ create, update }) => {
				settingsRow = settingsRow ? { ...settingsRow, ...update } : { ...create };
				return settingsRow;
			},
		},
		trelloUserBoard: {
			findUnique: async ({ where }) => userBoards.get(where.userId) || null,
			findMany: async () => [...userBoards.values()],
			deleteMany: async ({ where }) => { userBoards.delete(where.userId); },
			upsert: async ({ where, create, update }) => {
				const next = userBoards.has(where.userId)
					? { ...userBoards.get(where.userId), ...update }
					: { ...create };
				userBoards.set(where.userId, next);
				return next;
			},
		},
		trelloSectorBoard: {
			findUnique: async ({ where }) => sectorBoards.get(where.sectorId) || null,
			findMany: async () => [...sectorBoards.values()],
			deleteMany: async ({ where }) => { sectorBoards.delete(where.sectorId); },
			upsert: async ({ where, create, update }) => {
				const next = sectorBoards.has(where.sectorId)
					? { ...sectorBoards.get(where.sectorId), ...update }
					: { ...create };
				sectorBoards.set(where.sectorId, next);
				return next;
			},
		},
	};
};

test('maskToken mostra so os 4 ultimos caracteres', () => {
	assert.strictEqual(maskToken(null), null);
	assert.strictEqual(maskToken(''), null);
	assert.strictEqual(maskToken('abcd1234efgh5678'), '••••5678');
	assert.strictEqual(maskToken('ab'), '••••ab');
});

test('isMaskedToken reconhece a sentinela de mascara', () => {
	assert.strictEqual(isMaskedToken('••••5678'), true);
	assert.strictEqual(isMaskedToken('token-real'), false);
	assert.strictEqual(isMaskedToken(undefined), false);
});

test('writeSettings mantem o token atual quando omitido ou mascarado', async () => {
	const prisma = makePrismaStub();
	await writeSettings(prisma, { apiKey: 'key1', apiToken: 'secret-token', updatedById: 7 });
	assert.strictEqual(prisma.settingsRow.apiToken, 'secret-token');

	await writeSettings(prisma, { apiKey: 'key2', apiToken: undefined, updatedById: 7 });
	assert.strictEqual(prisma.settingsRow.apiKey, 'key2');
	assert.strictEqual(prisma.settingsRow.apiToken, 'secret-token');

	await writeSettings(prisma, { apiKey: 'key3', apiToken: '••••oken', updatedById: 7 });
	assert.strictEqual(prisma.settingsRow.apiKey, 'key3');
	assert.strictEqual(prisma.settingsRow.apiToken, 'secret-token');

	await writeSettings(prisma, { apiKey: 'key3', apiToken: 'new-token', updatedById: 7 });
	assert.strictEqual(prisma.settingsRow.apiToken, 'new-token');
});

test('redactSettings nunca expoe o token completo', () => {
	const redacted = redactSettings({ apiKey: 'k', apiToken: 'super-secret-1234', updatedAt: 'x' });
	assert.strictEqual(redacted.configured, true);
	assert.strictEqual(redacted.apiTokenMasked, '••••1234');
	assert.ok(!JSON.stringify(redacted).includes('super-secret'));

	const empty = redactSettings(null);
	assert.deepStrictEqual(empty, { configured: false, apiKey: null, apiTokenMasked: null, updatedAt: null });
});

test('isConfigured exige key E token', () => {
	assert.strictEqual(isConfigured({ apiKey: 'k', apiToken: 't' }), true);
	assert.strictEqual(isConfigured({ apiKey: 'k', apiToken: null }), false);
	assert.strictEqual(isConfigured(null), false);
});

test('writeUserBoard faz upsert e boardId null remove o mapeamento', async () => {
	const prisma = makePrismaStub();
	await writeUserBoard(prisma, { userId: 5, boardId: 'b1', boardName: 'Board', listId: 'l1', listName: 'To Do' });
	assert.strictEqual(prisma.userBoards.get(5).listId, 'l1');

	await writeUserBoard(prisma, { userId: 5, boardId: 'b1', boardName: 'Board', listId: 'l2', listName: 'Doing' });
	assert.strictEqual(prisma.userBoards.get(5).listId, 'l2');

	await writeUserBoard(prisma, { userId: 5, boardId: null });
	assert.strictEqual(prisma.userBoards.has(5), false);
});

// Boards por setor (2026-08-11): mesmo contrato do trio de user-board, com a
// chave trocada de userId para sectorId — o card vai para o board do SETOR.
test('writeSectorBoard faz upsert e boardId null remove o mapeamento', async () => {
	const prisma = makePrismaStub();
	await writeSectorBoard(prisma, { sectorId: 3, boardId: 'b1', boardName: 'TI', listId: 'l1', listName: 'To Do' });
	assert.strictEqual(prisma.sectorBoards.get(3).listId, 'l1');

	await writeSectorBoard(prisma, { sectorId: 3, boardId: 'b1', boardName: 'TI', listId: 'l2', listName: 'Doing' });
	assert.strictEqual(prisma.sectorBoards.get(3).listId, 'l2');

	await writeSectorBoard(prisma, { sectorId: 3, boardId: null });
	assert.strictEqual(prisma.sectorBoards.has(3), false);
});

test('readSectorBoard e listSectorBoards leem pelo sectorId', async () => {
	const prisma = makePrismaStub();
	await writeSectorBoard(prisma, { sectorId: 3, boardId: 'b1', boardName: 'TI', listId: 'l1', listName: 'To Do' });
	await writeSectorBoard(prisma, { sectorId: 4, boardId: 'b2', boardName: 'Vendas', listId: 'l9', listName: 'Inbox' });

	const board = await readSectorBoard(prisma, 3);
	assert.strictEqual(board.boardId, 'b1');
	assert.strictEqual(await readSectorBoard(prisma, 99), null);

	const all = await listSectorBoards(prisma);
	assert.strictEqual(all.length, 2);
});
