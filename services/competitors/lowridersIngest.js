// Payload (DD-018 section 6) -> CompetitorProduct. Prisma is injected so the
// tests run with a stub. The upsert lives in lib/competitors/competitorUpsert.js
// (shared with Niagara Jeeps); the stale delete only runs when the floor passes.

const { buildProductIndex, matchPartNumber } = require('../../lib/competitors/skuMatch');
const { checkStaleFloor } = require('../../lib/competitors/lowriders/canaries');
const {
	UPSERT_BATCH_SIZE, UPDATE_SQL, INSERT_SQL, resolveCompetitor, upsertCompetitorRows,
} = require('../../lib/competitors/competitorUpsert');

const UNMATCHED_SAMPLE = 25;
const AMBIGUOUS_LOG_LIMIT = 50;

const DELETE_SQL = `
  DELETE FROM "CompetitorProduct" cp
  WHERE cp.competitor_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text($2::jsonb) s(sku)
      WHERE s.sku = cp.competitor_sku
    );
`;

function loadRcProducts(prisma) {
	return prisma.product.findMany({
		where: {
			jj_prefix: 'RC',
			searchable_sku: { not: null },
			NOT: [{ searchable_sku: '' }, { searchable_sku: { endsWith: '-' } }],
		},
		select: { sku: true, searchable_sku: true, status: true },
	});
}

async function ingestLowriders({ prisma, payload, thresholds = {}, logger, dryRun = false }) {
	const competitor = await resolveCompetitor(prisma, payload.competitor, dryRun);
	const index = buildProductIndex(await loadRcProducts(prisma));

	const rows = [];
	const unmatched = [];
	const ambiguous = [];
	for (const item of payload.items) {
		const match = matchPartNumber(index, item.partNumber);
		if (match.status === 'unmatched') {
			unmatched.push(item.competitorSku);
			continue;
		}
		if (match.status === 'ambiguous') ambiguous.push({ competitorSku: item.competitorSku, chosen: match.sku, candidates: match.candidates.map((c) => c.sku) });
		rows.push({ product_sku: match.sku, competitor_sku: item.competitorSku, competitor_price: item.effectivePrice, product_url: item.url || null });
	}

	const matched = rows.length;
	const matchRate = payload.items.length ? matched / payload.items.length : 0;
	logger.info(`[lowriders] step=match matched=${matched} unmatched=${unmatched.length} ambiguous=${ambiguous.length} matchRate=${matchRate.toFixed(3)}`);
	if (unmatched.length) logger.info(`[lowriders] unmatched sample: ${unmatched.slice(0, UNMATCHED_SAMPLE).join(', ')}`);
	for (const a of ambiguous.slice(0, AMBIGUOUS_LOG_LIMIT)) logger.warn(`[lowriders] ambiguous ${a.competitorSku} -> ${a.chosen} (candidates: ${a.candidates.join(', ')})`);

	// Count when a competitor row exists, regardless of dryRun, so a dry-run
	// report also shows the floor verdict.
	const existingCount = competitor ? await prisma.competitorProduct.count({ where: { competitor_id: competitor.id } }) : null;
	const staleFloor = checkStaleFloor({ matched, existingCount, thresholds });
	const counts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0, skipped: unmatched.length + (payload.collection?.invalidCount || 0), markedStale: 0 };
	const summary = {
		competitorId: competitor ? competitor.id : null, counts, matched, matchRate, existingCount, staleFloor,
		unmatchedSample: unmatched.slice(0, UNMATCHED_SAMPLE), ambiguousCount: ambiguous.length, dryRun,
	};

	if (dryRun) {
		logger.info('[lowriders] dry-run: no writes');
		return summary;
	}

	const written = await upsertCompetitorRows({ prisma, competitorId: competitor.id, rows });
	counts.updated = written.updated;
	counts.inserted = written.inserted;
	// What the update did not touch was already correct, so it is the honest
	// measure of how quiet the night was.
	counts.unchanged = Math.max(0, matched - counts.inserted - counts.updated);
	logger.info(`[lowriders] step=upsert inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged}`);

	const writtenSkus = rows.map((r) => r.competitor_sku);
	if (staleFloor.ok) {
		counts.deleted = Number(await prisma.$executeRawUnsafe(DELETE_SQL, competitor.id, JSON.stringify(writtenSkus))) || 0;
		logger.info(`[lowriders] step=stale deleted=${counts.deleted} floor=passed`);
	} else {
		counts.markedStale = await prisma.competitorProduct.count({ where: { competitor_id: competitor.id, competitor_sku: { notIn: writtenSkus } } });
		logger.warn(`[lowriders] step=stale deleted=0 floor=skipped STALE DELETE SKIPPED: ${staleFloor.reason} (${counts.markedStale} rows kept)`);
	}

	return summary;
}

module.exports = { ingestLowriders, UPDATE_SQL, INSERT_SQL, DELETE_SQL, UPSERT_BATCH_SIZE };
