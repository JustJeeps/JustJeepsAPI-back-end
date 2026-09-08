const test = require('node:test');
const assert = require('node:assert');

const {
	WATERMARK_KEY,
	readDigestWatermark,
	saveDigestWatermark,
	collectRequestsDigestData,
	collectRequestsWeeklyStatusData,
} = require('../../lib/reports/requestsDigest.js');

// Prisma entra por parametro — stub direto, nenhum contato com o Postgres
// (o .env local aponta para producao).

const makePrismaStub = ({ requests = [], activities = [] } = {}) => {
	const calls = { requestFindMany: [], activityFindMany: [], upsert: [] };
	let row = null;
	return {
		calls,
		setRow: (value) => { row = { key: WATERMARK_KEY, value }; },
		syncState: {
			findUnique: async () => row,
			upsert: async (args) => {
				calls.upsert.push(args);
				row = { key: args.where.key, value: row ? args.update.value : args.create.value };
				return row;
			},
		},
		request: {
			findMany: async (args) => {
				calls.requestFindMany.push(args);
				return requests;
			},
		},
		requestActivity: {
			findMany: async (args) => {
				calls.activityFindMany.push(args);
				return activities;
			},
		},
	};
};

test('readDigestWatermark retorna null sem estado gravado', async () => {
	const prisma = makePrismaStub();
	assert.strictEqual(await readDigestWatermark(prisma), null);
});

test('watermark faz roundtrip como Date', async () => {
	const prisma = makePrismaStub();
	const date = new Date('2026-08-01T12:00:00.000Z');
	await saveDigestWatermark(prisma, date);
	const read = await readDigestWatermark(prisma);
	assert.strictEqual(read.getTime(), date.getTime());
});

test('collect usa janela de 24h quando nao ha watermark', async () => {
	const prisma = makePrismaStub();
	const now = new Date('2026-08-01T12:00:00.000Z');
	const digest = await collectRequestsDigestData(prisma, { since: null, now });
	assert.strictEqual(digest.windowStart.getTime(), now.getTime() - 24 * 60 * 60 * 1000);
});

test('collect devolve as quatro secoes e consulta pelas datas certas', async () => {
	const prisma = makePrismaStub({ requests: [{ id: 1 }], activities: [{ id: 9 }] });
	const since = new Date('2026-07-31T08:00:00.000Z');
	const now = new Date('2026-08-01T08:00:00.000Z');
	const digest = await collectRequestsDigestData(prisma, { since, now });

	assert.deepStrictEqual(Object.keys(digest).sort(), ['aging', 'newRequests', 'now', 'unassigned', 'updates', 'windowStart'].sort());
	assert.strictEqual(digest.windowStart.getTime(), since.getTime());
	// novas solicitacoes: createdAt > watermark
	const newArgs = prisma.calls.requestFindMany.find((args) => args.where?.createdAt);
	assert.strictEqual(newArgs.where.createdAt.gt.getTime(), since.getTime());
	// updates: activities depois do watermark, sem as entradas "created"
	const activityArgs = prisma.calls.activityFindMany[0];
	assert.strictEqual(activityArgs.where.createdAt.gt.getTime(), since.getTime());
	assert.deepStrictEqual(activityArgs.where.action, { not: 'created' });
});

test('weekly status snapshot exclui deleted e agrega contagens por status', async () => {
	const calls = [];
	const requests = [
		{ id: 1, status: 'New Request', archivedAt: null, deletedAt: null },
		{ id: 2, status: 'Work in Progress', archivedAt: null, deletedAt: null },
		{ id: 3, status: 'Closed', archivedAt: null, deletedAt: null },
		{ id: 4, status: 'Closed', archivedAt: '2026-08-01T00:00:00.000Z', deletedAt: null },
	];

	const prisma = {
		request: {
			findMany: async (args) => {
				calls.push(args);
				return requests;
			},
		},
	};

	const now = new Date('2026-08-02T12:00:00.000Z');
	const summary = await collectRequestsWeeklyStatusData(prisma, { now });

	assert.strictEqual(calls.length, 1);
	assert.deepStrictEqual(calls[0].where, { deletedAt: null });
	assert.strictEqual(summary.now.getTime(), now.getTime());
	assert.strictEqual(summary.total, 4);
	assert.strictEqual(summary.closedCount, 2);
	assert.strictEqual(summary.openCount, 2);
	assert.strictEqual(summary.archivedCount, 1);
	assert.deepStrictEqual(summary.countsByStatus, {
		'New Request': 1,
		'Work in Progress': 1,
		Closed: 2,
	});
});
