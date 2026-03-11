const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const prisma = new PrismaClient();

const COMPETITOR_ID = 3; // PartsEngine
const FILE_PATH = path.join(__dirname, "results.csv");

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

async function seedPartsEngineCompetitorProducts() {
  const results = [];

  fs.createReadStream(FILE_PATH)
    .pipe(csv())
    .on("data", (row) => results.push(row))
    .on("end", async () => {
      let added = 0;
      let updated = 0;
      let deleted = 0;

      logWithTimestamp("Deleting existing PartsEngine competitorProduct records...");
      const deleteResult = await prisma.competitorProduct.deleteMany({
        where: { competitor_id: COMPETITOR_ID },
      });
      deleted = deleteResult.count;
      logWithTimestamp(`Deleted ${deleted} existing records.`);

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
      const existingBySku = new Map();

      for (const skuChunk of chunkArray(productSkus, LOOKUP_BATCH_SIZE)) {
        const existing = await prisma.competitorProduct.findMany({
          where: {
            competitor_id: COMPETITOR_ID,
            product_sku: { in: skuChunk },
          },
          select: { id: true, product_sku: true },
        });

        for (const record of existing) {
          existingBySku.set(record.product_sku, record.id);
        }
      }

      const creates = [];
      const updates = [];
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

      for (const [productSku, row] of rowBySku.entries()) {
        const existingId = existingBySku.get(productSku);

        if (existingId) {
          updates.push({
            id: existingId,
            data: {
              competitor_price: row.competitorPrice,
              competitor_sku: row.competitorSku,
              product_url: row.url,
            },
          });
        } else {
          creates.push({
            product_sku: productSku,
            competitor_id: COMPETITOR_ID,
            competitor_price: row.competitorPrice,
            competitor_sku: row.competitorSku,
            product_url: row.url,
          });
        }
      }

      if (creates.length > 0) {
        logWithTimestamp(`Creating ${creates.length} records...`);
        await prisma.competitorProduct.createMany({
          data: creates,
          skipDuplicates: true,
        });
        added = creates.length;
      }

      if (updates.length > 0) {
        logWithTimestamp(
          `Updating ${updates.length} records in chunks of ${UPDATE_BATCH_SIZE}...`
        );
      }
      let updatedSoFar = 0;
      for (const updateChunk of chunkArray(updates, UPDATE_BATCH_SIZE)) {
        await prisma.$transaction(
          updateChunk.map((update) =>
            prisma.competitorProduct.update({
              where: { id: update.id },
              data: update.data,
            })
          )
        );
        updated += updateChunk.length;
        updatedSoFar += updateChunk.length;
        logWithTimestamp(`Updated ${updatedSoFar}/${updates.length} records...`);
      }

      logWithTimestamp(`Done! ${deleted} deleted, ${added} added, ${updated} updated.`);
      await prisma.$disconnect();
    });
}

seedPartsEngineCompetitorProducts();