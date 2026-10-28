const MoparCost = require("../api-calls/mopar.js");

const prisma = require("../../../lib/prisma");

// Seed Mopar vendor products
const seedMoparProducts = async () => {
  console.log("Seeding Mopar vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    const vendorProductsData = await MoparCost();

    for (const data of vendorProductsData) {
      try {
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data["Item"],
            vendor_id: 10,
          },
        });

        if (existingVendorProduct) {
          vendorProductUpdatedCount++;
          await prisma.vendorProduct.update({
            where: {
              id: existingVendorProduct.id,
            },
            data: {
              vendor_cost: data["Cost"],
            },
          });
          continue;
        }

        const product = await prisma.product.findFirst({
          where: {
            searchable_sku: data["Item"],
            jj_prefix: "MO",
          },
        });

        if (!product) {
          console.warn(`Product not found for Mopar sku: ${data["Item"]}`);
          continue;
        }

        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 10,
          vendor_sku: data["Item"],
          vendor_cost: data["Cost"],
        };

        await prisma.vendorProduct.create({
          data: vendorProductData,
        });
        vendorProductCreatedCount++;
      } catch (error) {
        console.error(`Error processing vendor_sku ${data["Item"]}:`, error);
      }
    }

    console.log(`Mopar vendor products seeded successfully! 
      Total Mopar products created: ${vendorProductCreatedCount}
      Total Mopar products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from Mopar:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedMoparProducts();
module.exports = seedMoparProducts;
