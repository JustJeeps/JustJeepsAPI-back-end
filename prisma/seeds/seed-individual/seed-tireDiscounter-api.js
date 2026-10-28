const {
  getTireDiscounterSkus,
  makeApiRequestsInChunks,
} = require("../api-calls/tireDiscounter-api.js");

const prisma = require("../../../lib/prisma");

const seedTireDiscounterProducts = async () => {
  const startTimeMs = Date.now();
  console.log("🚀 Seeding Tire Discounter vendor products...");

  let created = 0;
  let skippedMissingProduct = 0;

  // ✅ Step 0: Clear old vendor products for Tire Discounter
  await prisma.vendorProduct.deleteMany({ where: { vendor_id: 7 } });
  console.log("🗑️ Deleted all existing Tire Discounter vendor products (vendor_id = 7)");

  try {
    const skuPairs = await getTireDiscounterSkus();
    const vendorProductsData = await makeApiRequestsInChunks(skuPairs, 20);

    const ourSkus = [...new Set(vendorProductsData.map((item) => item.ourSku))];
    const products = await prisma.product.findMany({
      where: { sku: { in: ourSkus } },
      select: { sku: true },
    });
    const productSkuSet = new Set(products.map((product) => product.sku));

    const vendorCreates = [];
    const mapUpdates = [];

    for (const data of vendorProductsData) {
      if (!productSkuSet.has(data.ourSku)) {
        skippedMissingProduct++;
        continue;
      }

      vendorCreates.push({
        product_sku: data.ourSku,
        vendor_id: 7,
        vendor_sku: data.theirSku,
        vendor_cost: parseFloat(data.price),
        vendor_inventory: data.inventory,
      });

      if (data.map) {
        mapUpdates.push({
          sku: data.ourSku,
          map: parseFloat(data.map),
        });
      }
    }

    const chunkSize = 500;
    for (let i = 0; i < vendorCreates.length; i += chunkSize) {
      const chunk = vendorCreates.slice(i, i + chunkSize);
      await prisma.vendorProduct.createMany({ data: chunk });
      created += chunk.length;
    }

    for (let i = 0; i < mapUpdates.length; i += chunkSize) {
      const chunk = mapUpdates.slice(i, i + chunkSize);
      await prisma.$transaction(
        chunk.map((update) =>
          prisma.product.update({
            where: { sku: update.sku },
            data: { MAP: update.map },
          })
        )
      );
    }

    console.log(`✅ Tire Discounter seeding complete.
  🆕 Created: ${created}
  ⚠️  Missing products: ${skippedMissingProduct}`);
  } catch (err) {
    console.error("❌ Seeding error:", err);
  } finally {
    const durationSec = ((Date.now() - startTimeMs) / 1000).toFixed(2);
    console.log(`⏱️  Seed execution time: ${durationSec}s`);
    await prisma.$disconnect();
  }
};

seedTireDiscounterProducts();
