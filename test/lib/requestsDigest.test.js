const test = require('node:test');
const assert = require('node:assert');

const {
	WATERMARK_KEY,
	readDigestWatermark,
	saveDigestWatermark,
	collectRequestsDigestData,
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
