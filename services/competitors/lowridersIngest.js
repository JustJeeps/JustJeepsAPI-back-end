// Payload (DD-018 section 6) -> CompetitorProduct. Prisma is injected so the
// tests run with a stub. Upsert SQL follows seed-tdot.js (jsonb_to_recordset,
// keyed on competitor_id + competitor_sku); the stale delete only runs when
// the floor passes.

const { buildProductIndex, matchPartNumber } = require('../../lib/competitors/skuMatch');
const { checkStaleFloor } = require('../../lib/competitors/lowriders/canaries');

const UPSERT_BATCH_SIZE = 2000;
const UNMATCHED_SAMPLE = 25;
const AMBIGUOUS_LOG_LIMIT = 50;

const UPDATE_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
      product_sku text, competitor_sku text, competitor_price double precision, product_url text
    )
  )
  UPDATE "CompetitorProduct" cp
  SET product_sku = input.product_sku,
      competitor_price = input.competitor_price,
      product_url = input.product_url,
      updated_at = CURRENT_TIMESTAMP
  FROM input
  WHERE cp.competitor_id = $1 AND cp.competitor_sku = input.competitor_sku;
`;

const INSERT_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
      product_sku text, competitor_sku text, competitor_price double precision, product_url text
    )
  )
  INSERT INTO "CompetitorProduct" (product_sku, competitor_id, competitor_price, competitor_sku, product_url)
  SELECT input.product_sku, $1, input.competitor_price, input.competitor_sku, input.product_url
  FROM input
  WHERE NOT EXISTS (
    SELECT 1 FROM "CompetitorProduct" cp
    WHERE cp.competitor_id = $1 AND cp.competitor_sku = input.competitor_sku
  );
`;

const DELETE_SQL = `
  DELETE FROM "CompetitorProduct" cp
  WHERE cp.competitor_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text($2::jsonb) s(sku)
      WHERE s.sku = cp.competitor_sku
    );
`;

function chunkArray(items, size) {
	const chunks = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

async function resolveCompetitor(prisma, competitor, dryRun) {
	const existing = await prisma.competitor.findFirst({ where: { name: { equals: competitor.name, mode: 'insensitive' } } });
	if (existing) return existing;
	if (dryRun) return null;
	return prisma.competitor.create({ data: { name: competitor.name, website: competitor.website } });
}

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
	const counts = { inserted: 0, updated: 0, deleted: 0, skipped: unmatched.length + (payload.collection?.invalidCount || 0), markedStale: 0 };
	const summary = {
		competitorId: competitor ? competitor.id : null, counts, matched, matchRate, existingCount, staleFloor,
		unmatchedSample: unmatched.slice(0, UNMATCHED_SAMPLE), ambiguousCount: ambiguous.length, dryRun,
	};

	if (dryRun) {
		logger.info('[lowriders] dry-run: no writes');
		return summary;
	}

	for (const batch of chunkArray(rows, UPSERT_BATCH_SIZE)) {
		const json = JSON.stringify(batch);
		const [updated, inserted] = await prisma.$transaction([
			prisma.$executeRawUnsafe(UPDATE_SQL, competitor.id, json),
			prisma.$executeRawUnsafe(INSERT_SQL, competitor.id, json),
		]);
		counts.updated += Number(updated) || 0;
		counts.inserted += Number(inserted) || 0;
	}
	logger.info(`[lowriders] step=upsert inserted=${counts.inserted} updated=${counts.updated}`);

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
