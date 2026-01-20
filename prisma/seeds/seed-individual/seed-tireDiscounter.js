const { PrismaClient } = require("@prisma/client");
const tireDiscounterCost = require("../api-calls/tire-discounter-excel.js");

const prisma = new PrismaClient();

// Seed TireDiscounter products
const seedTireDiscounterProducts = async () => {
  console.log("Seeding TireDiscounter vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    const vendorProductsData = await tireDiscounterCost();

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of vendorProductsData) {
      // console.log(`Cost:`, data["Cost"]);
      try {
        // Check if a vendor product with the same vendor_sku already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data["Item"],
            vendor_id: 7, // Replace with the appropriate vendor_id for TireDiscounter
          },
        });

        // console.log(`existingVendorProduct:`, existingVendorProduct);

        if (existingVendorProduct) {
          vendorProductUpdatedCount++; // Increment the updated count
          // Update the existing vendor product with new data
          await prisma.vendorProduct.update({
            where: {
              id: existingVendorProduct.id,
            },
            data: {
              vendor_sku: data["Item"],
              vendor_cost: data["Cost"], // Convert to float
              // Add any other fields that you want to update
            },
          });

          continue; // Move to the next iteration
        }

        // Retrieve the product_sku from the Product table using the TireDiscounter sku as reference
        let product;
        product = await prisma.product.findFirst({
          where: {
            searchable_sku: data["Item"], // Replace with the appropriate field for TireDiscounter
            OR: [
              { brand_name: "Bridgestone" },
              { brand_name: "Michelin" },
              { brand_name: "Firestone" },
              { brand_name: "BF Goodrich Tires" },
              { brand_name: "YKW" },
              { brand_name: "Falken WildPeak" },
              { brand_name: "Nitto Tire" },
            ],
          },
        });

        // console.log(`product:`, product);

        if (!product) {
          console.error(
            `Product not found for TireDiscounter sku: ${data["Item"]}`
          );
          continue; // Skip to the next iteration
        }

        // Update the data with the retrieved product_sku and vendor_id
        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 7, // Replace with the appropriate vendor_id for TireDiscounter
          vendor_sku: data["Item"],
          vendor_cost: data["Cost"], // Convert to float
          
        };
        vendorProductCreatedCount++; // Increment the created count
        // Create the vendor product
        await prisma.vendorProduct.create({
          data: vendorProductData,
        });
      } catch (error) {
        // console.error(`Error processing vendor_sku:`, error);
        // You can choose to continue to the next iteration or handle the error as needed
      }
    }

    console.log(`TireDiscounter vendor products seeded successfully! 
      Total TireDiscounter products created: ${vendorProductCreatedCount}
      Total TireDiscounter products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from TireDiscounter:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedTireDiscounterProducts();
module.exports = seedTireDiscounterProducts;
