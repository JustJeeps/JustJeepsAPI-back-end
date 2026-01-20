const { PrismaClient } = require("@prisma/client");
const RoughCountryCost = require("../api-calls/roughCountry-excel.js");

const prisma = new PrismaClient();

// Seed roughCountry products
const seedRoughCountry = async () => {
  console.log("Seeding roughCountry vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // // ✅ Step 0: Clear old vendor products for Rough Country
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 9 } });
    // console.log("🗑️ Deleted all existing Rough Country vendor products (vendor_id = 9)");

    const vendorProductsData = await RoughCountryCost();

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of vendorProductsData) {
console.log(`data:`, data);
      try {
        // Check if a vendor product with the same vendor_sku already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data["SKU"],
            vendor_id: 9, // Replace with the appropriate vendor_id for roughCountry
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
              vendor_cost: data["COST"]*1.5, // Convert to float
              vendor_inventory_string: data["AVAILABILITY"],
              vendor_inventory: data["TN_STOCK"],
          
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
          console.log(`COST:`, data["COST"]*1.5);
          console.log(`AVAILABILITY:`, data["AVAILABILITY"]);

          continue; // Move to the next iteration
        }

        // Retrieve the product_sku from the Product table using the roughCountry sku as reference
        let product;
        product = await prisma.product.findFirst({
          where: {
            searchable_sku: data["SKU"], // Replace with the appropriate field for roughCountry
            OR: [{ brand_name: "Rough Country" }],
          },
        });

        // console.log(`product:`, product);

        if (!product) {
          console
            .error
            // `Product not found for roughCountry sku: ${data["SKU"]}`
            ();
          continue; // Skip to the next iteration
        }

        // Update the data with the retrieved product_sku and vendor_id
        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 9, // Replace with the appropriate vendor_id for roughCountry
          vendor_sku: data["SKU"],
          vendor_cost: data["COST"]*1.5, // Convert to float
          vendor_inventory_string: data["AVAILABILITY"],
          vendor_inventory: data["TN_STOCK"]

        };
          //CONSOLE LOG TO CONFITM IF vendor_inventory_string IS BEING UPDATED
          console.log(`vendor_inventory_string:`, data["AVAILABILITY"])

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

    console.log(`roughCountry vendor products seeded successfully! 
      Total roughCountry products created: ${vendorProductCreatedCount}
      Total roughCountry products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from roughCountry:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedRoughCountry();
module.exports = seedRoughCountry;
