const test = require('node:test');
const assert = require('node:assert');

const { ingestNiagara, NiagaraIngestError } = require('../../../services/competitors/niagaraIngest');

const silent = { info() {}, warn() {}, error() {} };
const thresholds = { minItems: 1, minMatched: 1, maxFailedRequestRatio: 0.1, maxBrandsFailedRatio: 0.2, maxInvalidRatio: 0.02, matchDropRatio: 0.8 };
const brands = [{ jjPrefix: 'BIL', handle: 'bilstein', skuPrefixes: ['BIL-'] }, { jjPrefix: 'RC', handle: 'rough-country', skuPrefixes: ['RCS'] }];
const products = [
	{ sku: 'BIL-24-186728', searchable_sku: '24-186728', jj_prefix: 'BIL', status: 1 },
	{ sku: 'RC-55658', searchable_sku: '55658', jj_prefix: 'RC', status: 1 },
];
const item = (jjPrefix, competitorSku, price = 10) => ({ jjPrefix, competitorSku, price, url: `https://niagarajeeps.ca/products/${competitorSku}` });
const payloadOf = (items, extra = {}) => ({ schemaVersion: 1, source: 'niagara', sample: null, collection: { invalidCount: 1 }, items, ...extra });

function makePrisma({ competitor = { id: 7, name: 'Niagara Jeeps' }, staleCount = 4, updateCount = 1, insertCount = 1 } = {}) {
	const raw = [];
	const created = [];
	const findManyArgs = [];
	return {
		raw, created, findManyArgs,
		competitor: {
			findFirst: async () => competitor,
			create: async ({ data }) => { created.push(data); return { id: 99, ...data }; },
		},
		product: { findMany: async (args) => { findManyArgs.push(args); return products.filter((p) => args.where.jj_prefix.in.includes(p.jj_prefix)); } },
		$executeRawUnsafe(sql, ...params) {
			raw.push({ sql, params });
			return Promise.resolve(sql.includes('UPDATE "CompetitorProduct"') ? updateCount : insertCount);
		},
		$queryRawUnsafe: async (sql, ...params) => { raw.push({ sql, params }); return [{ stale: staleCount }]; },
		$transaction: async (ops) => Promise.all(ops),
	};
}

test('matches by brand, writes through the shared upsert and only counts stale rows', async () => {
	const prisma = makePrisma();
	const result = await ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'BIL-24-186728', 152.95), item('RC', 'RCS55658', 99), item('BIL', 'NOPE')]), brands, thresholds, logger: silent, baselineRows: null });
	assert.strictEqual(result.competitorId, 7);
	assert.strictEqual(result.matched, 2);
	assert.deepStrictEqual(result.counts, { inserted: 1, updated: 1, unchanged: 0, deleted: 0, skipped: 2, markedStale: 4 });
	const upsert = prisma.raw.find((r) => r.sql.includes('UPDATE "CompetitorProduct"'));
	assert.deepStrictEqual(JSON.parse(upsert.params[1]).map((r) => [r.product_sku, r.competitor_sku, r.competitor_price]), [['BIL-24-186728', 'BIL-24-186728', 152.95], ['RC-55658', 'RCS55658', 99]]);
	assert.deepStrictEqual(result.report.unmatched.map((u) => u.competitorSku), ['NOPE']);
});

test('never issues a DELETE', async () => {
	const prisma = makePrisma();
	await ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'BIL-24-186728')]), brands, thresholds, logger: silent, baselineRows: null });
	assert.ok(prisma.raw.every((r) => !/^\s*DELETE/i.test(r.sql)), 'no DELETE statement');
});

test('loads only the products of the brands in the payload, without empty or trailing-dash skus', async () => {
	const prisma = makePrisma();
	await ingestNiagara({ prisma, payload: payloadOf([item('RC', 'RCS55658')]), brands, thresholds, logger: silent, baselineRows: null });
	const where = prisma.findManyArgs[0].where;
	assert.deepStrictEqual(where.jj_prefix, { in: ['RC'] });
	assert.deepStrictEqual(where.NOT, [{ searchable_sku: '' }, { searchable_sku: { endsWith: '-' } }]);
});

test('a dry run matches and reports but writes nothing and creates no competitor', async () => {
	const prisma = makePrisma({ competitor: null });
	const result = await ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'BIL-24-186728')]), brands, thresholds, logger: silent, dryRun: true, baselineRows: null });
	assert.strictEqual(result.matched, 1);
	assert.strictEqual(result.competitorId, null);
	assert.deepStrictEqual(prisma.created, []);
	assert.ok(prisma.raw.every((r) => !r.sql.includes('INSERT') && !r.sql.includes('UPDATE')));
});

test('the first real run creates the competitor by name', async () => {
	const prisma = makePrisma({ competitor: null });
	const result = await ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'BIL-24-186728')]), brands, thresholds, logger: silent, baselineRows: null });
	assert.deepStrictEqual(prisma.created, [{ name: 'Niagara Jeeps', website: 'https://niagarajeeps.ca/' }]);
	assert.strictEqual(result.competitorId, 99);
});

test('a match drop against the last full run aborts before any write', async () => {
	const prisma = makePrisma();
	await assert.rejects(
		ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'BIL-24-186728')]), brands, thresholds, logger: silent, baselineRows: 100 }),
		(err) => err instanceof NiagaraIngestError && err.failures.some((f) => f.code === 'MATCH_DROP'),
	);
	assert.ok(prisma.raw.every((r) => !r.sql.includes('INSERT')));
});

test('a sample run skips the matched floor and the stale count', async () => {
	const prisma = makePrisma();
	const result = await ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'BIL-24-186728')], { sample: { brands: ['BIL'], maxPages: 1 } }), brands, thresholds: { ...thresholds, minMatched: 500 }, logger: silent, baselineRows: null });
	assert.strictEqual(result.matched, 1);
	assert.strictEqual(result.counts.markedStale, null);
	assert.ok(prisma.raw.every((r) => !r.sql.includes('jsonb_array_elements_text')));
});

test('a refused run does not even create the competitor', async () => {
	const prisma = makePrisma({ competitor: null });
	await assert.rejects(ingestNiagara({ prisma, payload: payloadOf([item('BIL', 'NOPE')]), brands, thresholds, logger: silent, baselineRows: null }), /BELOW_MIN_MATCHED|NIAGARA_MATCH_GUARD/);
	assert.deepStrictEqual(prisma.created, []);
});

test('a write that stops mid-way says how many rows were already written', async () => {
	const prisma = makePrisma();
	let calls = 0;
	prisma.$transaction = async (ops) => {
		calls += 1;
		if (calls > 1) throw new Error('connection reset');
		return Promise.all(ops);
	};
	const many = Array.from({ length: 2001 }, (_, i) => item('BIL', `BIL-24-186728${i ? `-${i}` : ''}`));
	products.push(...many.slice(1).map((m, i) => ({ sku: `BIL-X${i}`, searchable_sku: m.competitorSku.slice(4), jj_prefix: 'BIL', status: 1 })));
	await assert.rejects(ingestNiagara({ prisma, payload: payloadOf(many), brands, thresholds, logger: silent, baselineRows: null }), /NIAGARA_WRITE_FAILED: write stopped after 1 inserted and 1 updated rows/);
	products.splice(2);
});
