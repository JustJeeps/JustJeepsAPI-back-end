const dirtyDogCost = require("../api-calls/dirtyDog-excel.js");

const prisma = require("../../../lib/prisma");

// Seed DirtyDog products
const seedDirtDog = async () => {
  console.log("Seeding DirtyDog vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    const vendorProductsData = await dirtyDogCost();

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of vendorProductsData) {
      // console.log(`MAP:`, data["MAP"]);
      try {
        // Check if a vendor product with the same vendor_sku already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data["SKU"],
            vendor_id: 7, // Replace with the appropriate vendor_id for DirtyDog
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
              vendor_sku: data["SKU"],
              vendor_cost: data["Just Jeeps cost"], // Convert to float
              // Add any other fields that you want to update
            },
          });

          //update the MAP in product table
          await prisma.product.update({
            where: {
              sku: existingVendorProduct.product_sku,
            },
            data: {
              MAP: data["MAP"], // Convert to float
              // Add any other fields that you want to update
            },
          });
          clr;

          //CONSOLE LOG TO CONFITM IF THE MAP IS BEING UPDATED
          console.log(`MAP:`, data["MAP"]);
          console.log(`SKU:`, data["SKU"]);
          console.log(`SKU:`, data["Just Jeeps cost"]);

          continue; // Move to the next iteration
        }

        // Retrieve the product_sku from the Product table using the DirtyDog sku as reference
        let product;
        product = await prisma.product.findFirst({
          where: {
            searchable_sku: data["SKU"], // Replace with the appropriate field for DirtyDog
            OR: [{ brand_name: "Dirty Dog 4X4" }],
          },
        });

        // console.log(`product:`, product);

        if (!product) {
          console
            .error
            // `Product not found for DirtyDog sku: ${data["SKU"]}`
            ();
          continue; // Skip to the next iteration
        }

        // Update the data with the retrieved product_sku and vendor_id
        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 7, // Replace with the appropriate vendor_id for DirtyDog
          vendor_sku: data["SKU"],
          vendor_cost: data["Just Jeeps cost"], // Convert to float
        };
        vendorProductCreatedCount++; // Increment the created count
        // Create the vendor product
        await prisma.vendorProduct.create({
          data: vendorProductData,
        });

        //update the MAP in product table
        await prisma.product.update({
          where: {
            sku: product.sku,
          },
          data: {
            MAP: data["MAP"], // Convert to float
            // Add any other fields that you want to update
          },
        });

      } catch (error) {
        // console.error(`Error processing vendor_sku:`, error);
        // You can choose to continue to the next iteration or handle the error as needed
      }
    }

    console.log(`DirtyDog vendor products seeded successfully! 
      Total DirtyDog products created: ${vendorProductCreatedCount}
      Total DirtyDog products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from DirtyDog:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedDirtDog();
module.exports = seedDirtDog;
