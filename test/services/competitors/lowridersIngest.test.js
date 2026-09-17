const test = require('node:test');
const assert = require('node:assert');

const { ingestLowriders, UPSERT_BATCH_SIZE } = require('../../../services/competitors/lowridersIngest');

const silent = { info() {}, warn() {}, error() {} };

function item(competitorSku, effectivePrice = 10, url = `https://lowriders.ca/i-${competitorSku}?`) {
	return { competitorSku, partNumber: competitorSku, effectivePrice, url, brandName: 'Rough Country' };
}

function payloadOf(items) {
	return { schemaVersion: 1, source: 'lowriders', competitor: { name: 'Lowriders', website: 'https://www.lowriders.ca/' }, collection: { invalidCount: 2 }, items };
}

// Records every raw statement; $transaction resolves the recorded ops.
function makePrisma({ competitor = { id: 5, name: 'Lowriders' }, products = [], lastRun = null, staleCount = 3, deleteCount = 4 } = {}) {
	const raw = [];
	const created = [];
	return {
		raw,
		created,
		competitor: {
			findFirst: async () => competitor,
			create: async ({ data }) => { created.push(data); return { id: 99, ...data }; },
		},
		product: { findMany: async () => products },
		ingestRun: { findFirst: async () => lastRun },
		competitorProduct: { count: async () => staleCount },
		$executeRawUnsafe(sql, ...params) {
			const op = { sql, params };
			raw.push(op);
			const count = sql.trimStart().startsWith('DELETE') ? deleteCount : sql.includes('UPDATE "CompetitorProduct"') ? 2 : 1;
			return Object.assign(Promise.resolve(count), op);
		},
		$transaction: async (ops) => Promise.all(ops),
	};
}

const products = [
	{ sku: 'RC-63470', searchable_sku: '63470', status: 1 },
	{ sku: 'RC-2620_RED', searchable_sku: '2620_RED', status: 1 },
];

test('matches, upserts in one batch and deletes stale rows when the floor passes', async () => {
	const prisma = makePrisma({ products, lastRun: { rowsInserted: 1, rowsUpdated: 1 } });
	const result = await ingestLowriders({
		prisma, payload: payloadOf([item('63470', 846.65), item('2620RED', 745.61), item('NOPE')]),
		thresholds: { minMatched: 1, matchDropRatio: 0.8 }, logger: silent,
	});
	assert.strictEqual(result.competitorId, 5);
	assert.strictEqual(result.matched, 2);
	assert.strictEqual(result.counts.skipped, 3, 'one unmatched + two invalid from the collection');
	assert.deepStrictEqual(result.unmatchedSample, ['NOPE']);
	assert.strictEqual(result.staleFloor.ok, true);
	assert.deepStrictEqual(result.counts, { inserted: 1, updated: 2, deleted: 4, skipped: 3, markedStale: 0 });

	const [update, insert, del] = prisma.raw;
	assert.match(update.sql, /UPDATE "CompetitorProduct"/);
	assert.match(update.sql, /updated_at = CURRENT_TIMESTAMP/);
	assert.strictEqual(update.params[0], 5);
	const rows = JSON.parse(update.params[1]);
	assert.deepStrictEqual(rows, [
		{ product_sku: 'RC-63470', competitor_sku: '63470', competitor_price: 846.65, product_url: 'https://lowriders.ca/i-63470?' },
		{ product_sku: 'RC-2620_RED', competitor_sku: '2620RED', competitor_price: 745.61, product_url: 'https://lowriders.ca/i-2620RED?' },
	]);
	assert.match(insert.sql, /INSERT INTO "CompetitorProduct"/);
	assert.match(del.sql, /^\s*DELETE FROM "CompetitorProduct"/);
	assert.deepStrictEqual(JSON.parse(del.params[1]), ['63470', '2620RED']);
});

// A thin run must never delete: prices update, rows stay, the log shouts.
test('when the floor fails the upsert still runs and the delete is skipped', async () => {
	const prisma = makePrisma({ products, lastRun: { rowsInserted: 100, rowsUpdated: 100 } });
	const warnings = [];
	const result = await ingestLowriders({
		prisma, payload: payloadOf([item('63470')]), thresholds: { minMatched: 1, matchDropRatio: 0.8 }, logger: { ...silent, warn: (m) => warnings.push(m) },
	});
	assert.strictEqual(result.staleFloor.ok, false);
	assert.strictEqual(result.counts.deleted, 0);
	assert.strictEqual(result.counts.markedStale, 3);
	assert.strictEqual(prisma.raw.length, 2, 'update + insert only');
	assert.ok(warnings.some((w) => w.includes('STALE DELETE SKIPPED')));
});

test('a previous success with zero writes (dry run) is not a baseline', async () => {
	const prisma = makePrisma({ products, lastRun: { rowsInserted: 0, rowsUpdated: 0 } });
	const result = await ingestLowriders({ prisma, payload: payloadOf([item('63470')]), thresholds: { minMatched: 1 }, logger: silent });
	assert.strictEqual(result.previousMatched, null);
	assert.strictEqual(result.staleFloor.ok, true);
});

test('creates the competitor by name when it is missing', async () => {
	const prisma = makePrisma({ competitor: null, products });
	const result = await ingestLowriders({ prisma, payload: payloadOf([item('63470')]), thresholds: { minMatched: 1 }, logger: silent });
	assert.strictEqual(result.competitorId, 99);
	assert.deepStrictEqual(prisma.created, [{ name: 'Lowriders', website: 'https://www.lowriders.ca/' }]);
});

test('dry run matches and reports but writes nothing and creates nothing', async () => {
	const prisma = makePrisma({ competitor: null, products });
	const result = await ingestLowriders({ prisma, payload: payloadOf([item('63470'), item('X')]), thresholds: { minMatched: 1 }, logger: silent, dryRun: true });
	assert.strictEqual(result.dryRun, true);
	assert.strictEqual(result.matched, 1);
	assert.strictEqual(result.matchRate, 0.5);
	assert.strictEqual(result.competitorId, null);
	assert.strictEqual(prisma.raw.length, 0);
	assert.strictEqual(prisma.created.length, 0);
});

test('upserts in batches of UPSERT_BATCH_SIZE', async () => {
	const many = Array.from({ length: UPSERT_BATCH_SIZE + 1 }, (_, i) => ({ sku: `RC-P${i}`, searchable_sku: `P${i}`, status: 1 }));
	const prisma = makePrisma({ products: many });
	await ingestLowriders({ prisma, payload: payloadOf(many.map((p) => item(p.searchable_sku))), thresholds: { minMatched: 1 }, logger: silent });
	const updates = prisma.raw.filter((op) => op.sql.includes('UPDATE "CompetitorProduct"'));
	assert.strictEqual(updates.length, 2);
	assert.strictEqual(JSON.parse(updates[0].params[1]).length, UPSERT_BATCH_SIZE);
	assert.strictEqual(JSON.parse(updates[1].params[1]).length, 1);
});
