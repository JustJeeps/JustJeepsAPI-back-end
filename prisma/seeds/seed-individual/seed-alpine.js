const alpineCost = require("../api-calls/alpine.js");

const prisma = require("../../../lib/prisma");

// Seed alpine vendor products
const seedalpineProducts = async () => {
  console.log("Seeding alpine vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

        // ✅ Step 0: Clear old vendor products for Alpine
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: 13 } });
    console.log("🗑️ Deleted all existing Alpine vendor products (vendor_id = 13)");

    const vendorProductsData = await alpineCost();

    for (const data of vendorProductsData) {
      try {
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data["Item"],
            vendor_id: 13,
          },
        });

        if (existingVendorProduct) {
          vendorProductUpdatedCount++;
          await prisma.vendorProduct.update({
            where: {
              id: existingVendorProduct.id,
            },
            data: {
              vendor_cost: data["Cost"]*1,
            },
          });
          continue;
        }

        const product = await prisma.product.findFirst({
          where: {
            searchable_sku: data["Item"],
            jj_prefix: "ALP",
          },
        });

        if (!product) {
          console.warn(`Product not found for alpine sku: ${data["Item"]}`);
          continue;
        }

        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 13,
          vendor_sku: data["Item"],
          vendor_cost: data["Cost"]*1,
        };

        await prisma.vendorProduct.create({
          data: vendorProductData,
        });
        vendorProductCreatedCount++;
      } catch (error) {
        console.error(`Error processing vendor_sku ${data["Item"]}:`, error);
      }
    }

    console.log(`alpine vendor products seeded successfully! 
      Total alpine products created: ${vendorProductCreatedCount}
      Total alpine products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from alpine:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedalpineProducts();
module.exports = seedalpineProducts;
