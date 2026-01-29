const fetchlowridersInventory = require("../api-calls/lowriders.js");

const prisma = require("../../../lib/prisma");

const seedLowriders = async () => {
  try {
    const lowridersData = await fetchlowridersInventory();
    console.log(`Total Lowriders products to process: ${lowridersData.length}`);

    let createdCount = 0;
    let updatedCount = 0;

    for (const data of lowridersData) {
      try {
        // Match Product by searchable_sku (RC prefix only)
        const product = await prisma.product.findFirst({
          where: {
            jj_prefix: "RC",
            searchable_sku: data.name,
          },
        });

        if (!product) {
          console.warn(`Product not found for RC searchable_sku: ${data.name}`);
          continue;
        }

        // Clean price (remove $ and commas)
        const price = parseFloat(data.price.replace(/[^0-9.]/g, ""));

        // Check if competitor product already exists
        const existing = await prisma.competitorProduct.findFirst({
          where: {
            competitor_id: 5,
            competitor_sku: data.name,
          },
        });

        if (existing) {
          await prisma.competitorProduct.update({
            where: { id: existing.id },
            data: {
              competitor_price: price,
              product_url: data.url || null,
            },
          });
          updatedCount++;
          continue;
        }

        // Create new competitor product
        await prisma.competitorProduct.create({
          data: {
            product_sku: product.sku,
            competitor_id: 5,
            competitor_price: price,
            competitor_sku: data.name,
            product_url: data.url || null,
          },
        });

        createdCount++;
      } catch (error) {
        console.error(`Error processing Lowriders code ${data.name}: ${error.message}`);
        continue;
      }
    }

    console.log(`✅ Lowriders seeding complete! Created: ${createdCount}, Updated: ${updatedCount}`);
  } catch (error) {
    console.error("❌ Error seeding Lowriders competitor products:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedLowriders();
module.exports = seedLowriders;
