const tdotCost = require("../api-calls/tdot-api.js");

const prisma = require("../../../lib/prisma");

const LOOKUP_BATCH_SIZE = 1000;
const UPSERT_BATCH_SIZE = 2000;
const LOG_EVERY = 500;
const TDOT_COMPETITOR_ID = 4;

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

// Seed Tdot competitor products
const seedTdot = async () => {
  try {

    // console.log("🗑️ Deleting old Tdot competitor products...");
    // await prisma.competitorProduct.deleteMany({
    //   where: { competitor_id: 4 }
    // });
    // console.log("✅ All previous Tdot competitor products deleted");
    
    
    const competitorProductsData = await tdotCost();
    const totalRows = competitorProductsData.length;
    logWithTimestamp(`Total competitor products to process: ${totalRows}`);

    const validRows = competitorProductsData
      .map((data) => {
        const tdotCode = data.tdot_code?.trim();
        const price = Number(data.tdot_price);
        if (!tdotCode || Number.isNaN(price)) {
          return null;
        }
        return {
          tdotCode,
          price,
          productUrl: data.product_url || null,
        };
      })
      .filter(Boolean);

    const validRowCount = validRows.length;
    logWithTimestamp(`Valid rows (non-empty code + price): ${validRowCount}`);

    const rowByTdotCode = new Map();
    let processed = 0;

    for (const row of validRows) {
      rowByTdotCode.set(row.tdotCode, row);
      processed++;
      if (processed % LOG_EVERY === 0) {
        logWithTimestamp(`Processed ${processed} rows...`);
      }
    }

    const uniqueCodes = Array.from(rowByTdotCode.keys());
    logWithTimestamp(`Unique tdot codes after dedupe: ${uniqueCodes.length}`);
    logWithTimestamp(`Loading products for ${uniqueCodes.length} tdot codes...`);

    const productByTdot = new Map();
    for (const codeChunk of chunkArray(uniqueCodes, LOOKUP_BATCH_SIZE)) {
      const products = await prisma.product.findMany({
        where: { tdot_code: { in: codeChunk } },
        select: { sku: true, tdot_code: true },
      });

      for (const product of products) {
        productByTdot.set(product.tdot_code, product.sku);
      }
    }

    logWithTimestamp(
      `Loading existing competitor products for ${uniqueCodes.length} tdot codes...`
    );

    const existingBySku = new Map();
    for (const codeChunk of chunkArray(uniqueCodes, LOOKUP_BATCH_SIZE)) {
      const existing = await prisma.competitorProduct.findMany({
        where: {
          competitor_id: TDOT_COMPETITOR_ID,
          competitor_sku: { in: codeChunk },
        },
        select: { competitor_sku: true },
      });

      for (const record of existing) {
        existingBySku.set(record.competitor_sku, true);
      }
    }

    const upsertRows = [];
    let createsCount = 0;
    let updatesCount = 0;
    let missingProductCount = 0;

    for (const [tdotCode, row] of rowByTdotCode.entries()) {
      const productSku = productByTdot.get(tdotCode);
      if (!productSku) {
        missingProductCount++;
        continue;
      }

      if (existingBySku.has(tdotCode)) {
        updatesCount++;
      } else {
        createsCount++;
      }

      upsertRows.push({
        product_sku: productSku,
        competitor_sku: tdotCode,
        competitor_price: row.price * 1,
        product_url: row.productUrl,
      });
    }

    logWithTimestamp(`Missing products for tdot codes: ${missingProductCount}`);
    logWithTimestamp(`Existing competitor products found: ${existingBySku.size}`);
    logWithTimestamp(`Creates queued: ${createsCount}`);
    logWithTimestamp(`Updates queued: ${updatesCount}`);

    const upsertBatch = async (batch) => {
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
          product_sku = input.product_sku,
          competitor_price = input.competitor_price,
          product_url = input.product_url
        FROM input
        WHERE cp.competitor_id = $1
          AND cp.competitor_sku = input.competitor_sku;
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
            AND cp.competitor_sku = input.competitor_sku
        );
      `;

      await prisma.$transaction([
        prisma.$executeRawUnsafe(updateSql, TDOT_COMPETITOR_ID, payload),
        prisma.$executeRawUnsafe(insertSql, TDOT_COMPETITOR_ID, payload),
      ]);
    };

    let processedUpserts = 0;
    for (const upsertChunk of chunkArray(upsertRows, UPSERT_BATCH_SIZE)) {
      await upsertBatch(upsertChunk);
      processedUpserts += upsertChunk.length;
      logWithTimestamp(
        `Upserted ${processedUpserts}/${upsertRows.length} competitor records...`
      );
    }

    logWithTimestamp(
      `Competitor products from Tdot seeded successfully! Created: ${createsCount}, Updated: ${updatesCount}`
    );
  } catch (error) {
    console.error("Error seeding competitor products from Tdot:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedTdot();
module.exports = seedTdot;
