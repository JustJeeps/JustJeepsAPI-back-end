// CompetitorProduct write shared by the in-house competitor scrapers
// (Lowriders DD-018, Niagara Jeeps DD-021). Moved out of lowridersIngest.js
// unchanged. Rows are keyed on competitor_id + competitor_sku (the table has
// no unique constraint, hence UPDATE then INSERT WHERE NOT EXISTS), and the
// UPDATE only touches a row whose price, link or product actually changed.
// Prisma is injected.

const UPSERT_BATCH_SIZE = 2000;

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
  WHERE cp.competitor_id = $1 AND cp.competitor_sku = input.competitor_sku
    -- Only rewrite a row that actually differs. Without this the scrape
    -- rewrote every matched row nightly: on 2026-09-19 all 7000 were touched
    -- while not one price had moved. IS DISTINCT FROM also covers NULL urls.
    AND (
      cp.competitor_price IS DISTINCT FROM input.competitor_price
      OR cp.product_url IS DISTINCT FROM input.product_url
      OR cp.product_sku IS DISTINCT FROM input.product_sku
    );
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

// rows: [{ product_sku, competitor_sku, competitor_price, product_url }]
async function upsertCompetitorRows({ prisma, competitorId, rows }) {
	const counts = { inserted: 0, updated: 0 };
	for (const batch of chunkArray(rows, UPSERT_BATCH_SIZE)) {
		const json = JSON.stringify(batch);
		const [updated, inserted] = await prisma.$transaction([
			prisma.$executeRawUnsafe(UPDATE_SQL, competitorId, json),
			prisma.$executeRawUnsafe(INSERT_SQL, competitorId, json),
		]);
		counts.updated += Number(updated) || 0;
		counts.inserted += Number(inserted) || 0;
	}
	return counts;
}

module.exports = { UPSERT_BATCH_SIZE, UPDATE_SQL, INSERT_SQL, chunkArray, resolveCompetitor, upsertCompetitorRows };
