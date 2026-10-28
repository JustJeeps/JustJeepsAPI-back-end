const alpineCost = require("../api-calls/alpine.js");

const prisma = require("../../../lib/prisma");

const VENDOR_ID = 13;
const JJ_PREFIX = "ALP";
const BATCH_SIZE = 500;

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

// Seed alpine vendor products
const seedalpineProducts = async () => {
  const startTimeMs = Date.now();
  console.log("Seeding alpine vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let skippedRowCount = 0;
    let missingProductCount = 0;
    const missingSkus = [];

    const vendorProductsData = await alpineCost();
    if (!Array.isArray(vendorProductsData)) {
      throw new Error("alpineCost() did not return an array");
    }

    const itemCostMap = new Map();
    for (const data of vendorProductsData) {
      const rawItem = data && data["Item"];
      const rawCost = data && data["Cost"];
      const item = String(rawItem || "").trim();
      const cost = Number(rawCost);

      if (!item || Number.isNaN(cost)) {
        skippedRowCount++;
        continue;
      }

      itemCostMap.set(item, cost);
    }

    // ✅ Step 0: Clear old vendor products for Alpine
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } });
    console.log(
      "🗑️ Deleted all existing Alpine vendor products (vendor_id = 13)"
    );

    const items = Array.from(itemCostMap.keys());
    const itemChunks = chunkArray(items, BATCH_SIZE);

    for (const itemChunk of itemChunks) {
      const products = await prisma.product.findMany({
        where: {
          searchable_sku: { in: itemChunk },
          jj_prefix: JJ_PREFIX,
        },
        select: {
          sku: true,
          searchable_sku: true,
        },
      });

      const productMap = new Map(
        products.map((product) => [product.searchable_sku, product.sku])
      );

      const createRows = [];
      for (const item of itemChunk) {
        const productSku = productMap.get(item);
        if (!productSku) {
          missingProductCount++;
          missingSkus.push(item);
          if (missingProductCount <= 10) {
            console.warn(`Product not found for alpine sku: ${item}`);
          }
          continue;
        }

        createRows.push({
          product_sku: productSku,
          vendor_id: VENDOR_ID,
          vendor_sku: item,
          vendor_cost: itemCostMap.get(item),
        });
      }

      if (createRows.length > 0) {
        const result = await prisma.vendorProduct.createMany({
          data: createRows,
        });
        vendorProductCreatedCount += result.count;
      }
    }

    console.log(`alpine vendor products seeded successfully!
      Total alpine products created: ${vendorProductCreatedCount}
      Total rows skipped: ${skippedRowCount}
      Total missing products: ${missingProductCount}`);
    if (missingSkus.length > 0) {
      console.log("First 20 missing Alpine SKUs:", missingSkus.slice(0, 20));
      const missingSet = new Set(missingSkus.map(s => s.toLowerCase()));
      console.log(`Unique missing Alpine SKUs (case-insensitive): ${missingSet.size}`);
    }
  } catch (error) {
    console.error("Error seeding vendor products from alpine:", error);
  } finally {
    const durationMs = Date.now() - startTimeMs;
    console.log(`Alpine seed completed in ${durationMs}ms`);
    await prisma.$disconnect();
  }
};

seedalpineProducts();
module.exports = seedalpineProducts;
