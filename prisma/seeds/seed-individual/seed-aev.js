const { PrismaClient } = require("@prisma/client");
const aevCost = require("../api-calls/aev.js");

const prisma = new PrismaClient();

// Seed AEV vendor products
const seedAEVProducts = async () => {
  console.log("Seeding AEV vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

        // ✅ Step 0: Clear old vendor products for AEV
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: 8 } });
    console.log("🗑️ Deleted all existing AEV vendor products (vendor_id = 8)");

    const vendorProductsData = await aevCost();

    for (const data of vendorProductsData) {
      try {
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data["Item"],
            vendor_id: 8,
          },
        });

        if (existingVendorProduct) {
          vendorProductUpdatedCount++;
          await prisma.vendorProduct.update({
            where: {
              id: existingVendorProduct.id,
            },
            data: {
              vendor_cost: data["Cost"]*1.5,
            },
          });
          continue;
        }

        const product = await prisma.product.findFirst({
          where: {
            searchable_sku: data["Item"],
            jj_prefix: "AEV",
          },
        });

        if (!product) {
          console.warn(`Product not found for AEV sku: ${data["Item"]}`);
          continue;
        }

        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 8,
          vendor_sku: data["Item"],
          vendor_cost: data["Cost"]*1.5,
        };

        await prisma.vendorProduct.create({
          data: vendorProductData,
        });
        vendorProductCreatedCount++;
      } catch (error) {
        console.error(`Error processing vendor_sku ${data["Item"]}:`, error);
      }
    }

    console.log(`AEV vendor products seeded successfully! 
      Total AEV products created: ${vendorProductCreatedCount}
      Total AEV products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from AEV:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedAEVProducts();
module.exports = seedAEVProducts;
