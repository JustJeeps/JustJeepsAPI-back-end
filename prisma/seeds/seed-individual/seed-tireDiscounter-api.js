const {
  getTireDiscounterSkus,
  makeApiRequestsInChunks,
} = require("../api-calls/tireDiscounter-api.js");

const prisma = require("../../../lib/prisma");

const seedTireDiscounterProducts = async () => {
  console.log("🚀 Seeding Tire Discounter vendor products...");

  let created = 0;
  let updated = 0;

      // ✅ Step 0: Clear old vendor products for Tire Discounter
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: 7 } });
    console.log("🗑️ Deleted all existing Tire Discounter vendor products (vendor_id = 7)");

  try {
    const skuPairs = await getTireDiscounterSkus();
    const vendorProductsData = await makeApiRequestsInChunks(skuPairs, 20);

    for (const data of vendorProductsData) {
      console.log(`🔍 Processing: ${data.ourSku} (${data.theirSku})`);

      try {
        // Exact match using ourSku
        const product = await prisma.product.findFirst({
          where: {
            sku: data.ourSku,
          },
        });

        if (!product) {
          console.warn(`⚠️  Product not found for exact SKU: ${data.ourSku}`);
          continue;
        }

        // Check if vendor product already exists
        const existing = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data.theirSku,
            vendor_id: 7,
          },
        });

        if (existing) {
          updated++;

          await prisma.vendorProduct.update({
            where: { id: existing.id },
            data: {
              vendor_cost: parseFloat(data.price),
              vendor_inventory: data.inventory,
            },
          });

          await prisma.product.update({
            where: { sku: product.sku },
            data: {
              MAP: data.map ? parseFloat(data.map) : null,
            },
          });

          continue;
        }

        // Create new vendorProduct
        await prisma.vendorProduct.create({
          data: {
            product_sku: product.sku,
            vendor_id: 7,
            vendor_sku: data.theirSku,
            vendor_cost: parseFloat(data.price),
            vendor_inventory: data.inventory,
          },
        });

        await prisma.product.update({
          where: { sku: product.sku },
          data: {
            MAP: data.map ? parseFloat(data.map) : null,
          },
        });

        created++;
      } catch (err) {
        console.error(`❌ Error processing ${data.ourSku}:`, err.message);
      }
    }

    console.log(`✅ Tire Discounter seeding complete.
🆕 Created: ${created}
🔁 Updated: ${updated}`);
  } catch (err) {
    console.error("❌ Seeding error:", err);
  } finally {
    await prisma.$disconnect();
  }
};

seedTireDiscounterProducts();
