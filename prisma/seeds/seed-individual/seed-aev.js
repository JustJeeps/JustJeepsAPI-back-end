const aevCost = require("../api-calls/aev.js");
const { USD_TO_CAD_RATE } = require("../../../utils/exchangeRate");

const prisma = require("../../../lib/prisma");

const LOOKUP_BATCH_SIZE = 1000;
const CREATE_BATCH_SIZE = 1000;
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

// Seed AEV vendor products
const seedAEVProducts = async () => {
  logWithTimestamp("Seeding AEV vendor products...");
  try {
    let createdCount = 0;
    let invalidRowCount = 0;
    let missingProductCount = 0;

    // Clear old vendor products for AEV
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: 8 } });
    logWithTimestamp("Deleted all existing AEV vendor products (vendor_id = 8)");

    const vendorProductsData = await aevCost();
    logWithTimestamp(`Total vendor products to process: ${vendorProductsData.length}`);

    const rowBySku = new Map();
    let processed = 0;

    for (const data of vendorProductsData) {
      const vendorSku = data["Item"]?.trim();
      const cost = Number(data["Cost"]);

      if (!vendorSku || Number.isNaN(cost)) {
        invalidRowCount++;
        continue;
      }

      rowBySku.set(vendorSku, { vendorSku, cost });
      processed++;

      if (processed % LOG_EVERY === 0) {
        logWithTimestamp(`Processed ${processed} rows...`);
      }
    }

    const uniqueSkus = Array.from(rowBySku.keys());
    logWithTimestamp(`Unique vendor SKUs after dedupe: ${uniqueSkus.length}`);
    logWithTimestamp(`Loading products for ${uniqueSkus.length} SKUs...`);

    const productBySku = new Map();
    for (const skuChunk of chunkArray(uniqueSkus, LOOKUP_BATCH_SIZE)) {
      const products = await prisma.product.findMany({
        where: {
          searchable_sku: { in: skuChunk },
          jj_prefix: "AEV",
        },
        select: { sku: true, searchable_sku: true },
      });

      for (const product of products) {
        productBySku.set(product.searchable_sku, product.sku);
      }
    }

    const creates = [];
    for (const row of rowBySku.values()) {
      const productSku = productBySku.get(row.vendorSku);
      if (!productSku) {
        missingProductCount++;
        continue;
      }

      creates.push({
        product_sku: productSku,
        vendor_id: 8,
        vendor_sku: row.vendorSku,
        vendor_cost: row.cost * USD_TO_CAD_RATE,
      });
    }

    logWithTimestamp(`Invalid rows skipped: ${invalidRowCount}`);
    logWithTimestamp(`Missing products for AEV SKUs: ${missingProductCount}`);
    logWithTimestamp(`Creates queued: ${creates.length}`);

    for (const createChunk of chunkArray(creates, CREATE_BATCH_SIZE)) {
      await prisma.vendorProduct.createMany({ data: createChunk });
      createdCount += createChunk.length;
      logWithTimestamp(`Created ${createdCount}/${creates.length} records...`);
    }

    logWithTimestamp(`AEV vendor products seeded successfully! Created: ${createdCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from AEV:", error);
  }
};

seedAEVProducts();
module.exports = seedAEVProducts;
