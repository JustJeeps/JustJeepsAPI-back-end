const tdotCost = require("../api-calls/tdot-api.js");

const prisma = require("../../../lib/prisma");

const LOOKUP_BATCH_SIZE = 1000;
const UPDATE_BATCH_SIZE = 500;
const LOG_EVERY = 500;

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
          competitor_id: 4,
          competitor_sku: { in: codeChunk },
        },
        select: { id: true, competitor_sku: true },
      });

      for (const record of existing) {
        existingBySku.set(record.competitor_sku, record.id);
      }
    }

    const creates = [];
    const updates = [];
    let missingProductCount = 0;

    for (const [tdotCode, row] of rowByTdotCode.entries()) {
      const productSku = productByTdot.get(tdotCode);
      if (!productSku) {
        missingProductCount++;
        continue;
      }

      const existingId = existingBySku.get(tdotCode);
      if (existingId) {
        updates.push({
          id: existingId,
          data: {
            competitor_price: row.price * 1,
            product_url: row.productUrl,
          },
        });
      } else {
        creates.push({
          product_sku: productSku,
          competitor_id: 4,
          competitor_price: row.price * 1,
          competitor_sku: tdotCode,
          product_url: row.productUrl,
        });
      }
    }

    logWithTimestamp(`Missing products for tdot codes: ${missingProductCount}`);
    logWithTimestamp(`Existing competitor products found: ${existingBySku.size}`);
    logWithTimestamp(`Creates queued: ${creates.length}`);

    if (creates.length > 0) {
      logWithTimestamp(`Creating ${creates.length} records...`);
      await prisma.competitorProduct.createMany({
        data: creates,
        skipDuplicates: true,
      });
    }

    if (updates.length > 0) {
      logWithTimestamp(
        `Updating ${updates.length} records in chunks of ${UPDATE_BATCH_SIZE}...`
      );
    }

    let competitorProductUpdatedCount = 0;
    for (const updateChunk of chunkArray(updates, UPDATE_BATCH_SIZE)) {
      await prisma.$transaction(
        updateChunk.map((update) =>
          prisma.competitorProduct.update({
            where: { id: update.id },
            data: update.data,
          })
        )
      );
      competitorProductUpdatedCount += updateChunk.length;
      logWithTimestamp(
        `Updated ${competitorProductUpdatedCount}/${updates.length} records...`
      );
    }

    logWithTimestamp(
      `Competitor products from Tdot seeded successfully! Created: ${creates.length}, Updated: ${competitorProductUpdatedCount}`
    );
  } catch (error) {
    console.error("Error seeding competitor products from Tdot:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedTdot();
module.exports = seedTdot;
