const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const prisma = new PrismaClient();

const COMPETITOR_ID = 3; // PartsEngine
const FILE_PATH = path.join(__dirname, "results.csv");

const LOOKUP_BATCH_SIZE = 1000;
const UPSERT_BATCH_SIZE = 2000;
const LOG_EVERY = 5000;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function logWithTimestamp(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function upsertCompetitorProductsBatch(batch) {
  if (!batch || batch.length === 0) return;

  const payload = JSON.stringify(batch);

  const updateSql = `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($2::jsonb) AS x(
        product_sku text,
        competitor_sku text,
        competitor_price double precision,
        product_url text
      )
    )
    UPDATE "CompetitorProduct" cp
    SET
      competitor_price = input.competitor_price,
      competitor_sku = input.competitor_sku,
      product_url = input.product_url
    FROM input
    WHERE cp.competitor_id = $1
      AND cp.product_sku = input.product_sku;
  `;

  const insertSql = `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($2::jsonb) AS x(
        product_sku text,
        competitor_sku text,
        competitor_price double precision,
        product_url text
      )
    )
    INSERT INTO "CompetitorProduct" (
      product_sku,
      competitor_id,
      competitor_price,
      competitor_sku,
      product_url
    )
    SELECT
      input.product_sku,
      $1,
      input.competitor_price,
      input.competitor_sku,
      input.product_url
    FROM input
    WHERE NOT EXISTS (
      SELECT 1
      FROM "CompetitorProduct" cp
      WHERE cp.competitor_id = $1
        AND cp.product_sku = input.product_sku
    );
  `;

  await prisma.$transaction([
    prisma.$executeRawUnsafe(updateSql, COMPETITOR_ID, payload),
    prisma.$executeRawUnsafe(insertSql, COMPETITOR_ID, payload),
  ]);
}

async function seedPartsEngineCompetitorProducts() {
  const results = [];

  fs.createReadStream(FILE_PATH)
    .pipe(csv())
    .on("data", (row) => results.push(row))
    .on("end", async () => {
      let added = 0;
      let updated = 0;
      let deleted = 0;

      // // Delete existing records for this competitor
      // logWithTimestamp("Deleting existing PartsEngine competitorProduct records...");
      // const deleteResult = await prisma.competitorProduct.deleteMany({
      //   where: { competitor_id: COMPETITOR_ID },
      // });
      // deleted = deleteResult.count;
      // logWithTimestamp(`Deleted ${deleted} existing records.`);

      const validRows = results
        .map((row) => {
          const url = row.URL?.trim();
          const competitorSku = row.SKU?.trim();
          const competitorPrice = parseFloat(row.Price?.trim());

          if (!url || Number.isNaN(competitorPrice)) {
            return null;
          }

          return {
            url,
            competitorSku,
            competitorPrice,
          };
        })
        .filter(Boolean);

      const uniqueUrls = Array.from(new Set(validRows.map((row) => row.url)));
      logWithTimestamp(`Loading products for ${uniqueUrls.length} unique URLs...`);
      const productByUrl = new Map();

      for (const urlChunk of chunkArray(uniqueUrls, LOOKUP_BATCH_SIZE)) {
        const products = await prisma.product.findMany({
          where: { partsEngine_code: { in: urlChunk } },
          select: { sku: true, partsEngine_code: true },
        });

        for (const product of products) {
          productByUrl.set(product.partsEngine_code, product.sku);
        }
      }

      const productSkus = Array.from(productByUrl.values());
      logWithTimestamp(`Loading existing competitor products for ${productSkus.length} SKUs...`);
      const existingBySku = new Set();

      for (const skuChunk of chunkArray(productSkus, LOOKUP_BATCH_SIZE)) {
        const existing = await prisma.competitorProduct.findMany({
          where: {
            competitor_id: COMPETITOR_ID,
            product_sku: { in: skuChunk },
          },
          select: { product_sku: true },
        });

        for (const record of existing) {
          existingBySku.add(record.product_sku);
        }
      }

      const rowBySku = new Map();
      let processed = 0;

      logWithTimestamp(`Preparing ${validRows.length} rows for writes...`);
      for (const row of validRows) {
        const productSku = productByUrl.get(row.url);

        if (!productSku) {
          continue;
        }

        rowBySku.set(productSku, row);

        processed++;
        if (processed % LOG_EVERY === 0) {
          logWithTimestamp(`Processed ${processed} rows...`);
        }
      }

      const upsertRows = [];
      let creates = 0;
      let updates = 0;

      for (const [productSku, row] of rowBySku.entries()) {
        if (existingBySku.has(productSku)) {
          updates++;
        } else {
          creates++;
        }

        upsertRows.push({
          product_sku: productSku,
          competitor_price: row.competitorPrice,
          competitor_sku: row.competitorSku,
          product_url: row.url,
        });
      }

      if (upsertRows.length > 0) {
        logWithTimestamp(`Upserting ${upsertRows.length} records in chunks of ${UPSERT_BATCH_SIZE}...`);
      }

      let upsertedSoFar = 0;
      for (const upsertChunk of chunkArray(upsertRows, UPSERT_BATCH_SIZE)) {
        await upsertCompetitorProductsBatch(upsertChunk);
        upsertedSoFar += upsertChunk.length;
        logWithTimestamp(`Upserted ${upsertedSoFar}/${upsertRows.length} records...`);
      }

      added = creates;
      updated = updates;

      logWithTimestamp(`Done! ${deleted} deleted, ${added} added, ${updated} updated.`);
      await prisma.$disconnect();
    });
}

seedPartsEngineCompetitorProducts();