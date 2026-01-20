const { PrismaClient } = require("@prisma/client");
const meyerApi = require("../api-calls/meyer-api.js");

const prisma = new PrismaClient();

// seed Meyer products
const seedMeyerVendorProducts = async () => {
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    //  // ✅ Step 0: Clear old vendor products for Meyer
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 2 } });
    // console.log("🗑️ Deleted all existing Meyer vendor products (vendor_id = 2)");

    // Call MeyerCost and get the processed responses
    const vendorProductsData = await meyerApi();

    // Loop through the vendorProductsData array and create/update vendor seproducts
    for (const data of vendorProductsData) {
      // console.log("data", data);
      // console.log("counter", counter);
      try {
        //if data = { statusCode: 500, errorCode: 40501, errorMessage: 'No results found' } skip to next iteration
        if (data.statusCode) {
          // console.error(`No results found for vendor_sku`);
          continue; // Skip to next iteration
        }

        // Check if a vendor product with the same vendor_sku already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data[0].ItemNumber,
            vendor_id: 2,
          },
        });

        if (existingVendorProduct) {
          console.log(existingVendorProduct);
          // console.log(
          //   `Vendor product with vendor_sku: ${data[0].ItemNumber} already exists, updating...`
          // );
          vendorProductUpdatedCount++; // Increment the updated count
          // Update the existing vendor product with new data
          await prisma.vendorProduct.update({
            where: {
              id: existingVendorProduct.id,
            },
            data: {
              vendor_sku: data[0].ItemNumber,
              vendor_cost: data[0].CustomerPrice,
              vendor_inventory: data[0].QtyAvailable,
              partStatus_meyer: data[0].PartStatus,
      
              // Add any other fields that you want to update
            },
          });

          //update partStatus_meyer in Product table
          await prisma.product.update({
            where: {
              sku: existingVendorProduct.product_sku,
            },
            data: {
              partStatus_meyer: data[0].PartStatus,
              meyer_length: data[0].Length,
              meyer_width: data[0].Width,
              meyer_height: data[0].Height,
              meyer_weight: data[0].Weight,
            },
          });

          // console.log(
          //   `Vendor product with vendor_sku: ${data[0].ItemNumber} updated successfully`
          // );
          // Increment the counter for updated vendor products
          continue; // Move to next iteration
        }

        // Retrieve the product_sku from the Product table using meyer_code as reference

        
        let product;
        product = await prisma.product.findFirst({
          where: {
            meyer_code: data[0].ItemNumber,
          },
        });

        if (!product) {
          console.error(
            `Product not found for meyer_code: ${data[0].ItemNumber}`
          );
          continue; // Skip to next iteration
        }

        // Update the data with the retrieved product_sku and vendor_id
        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 2,
          vendor_sku: data[0].ItemNumber,
          vendor_cost: data[0].CustomerPrice,
          vendor_inventory: data[0].QtyAvailable,
          partStatus_meyer: data[0].PartStatus,
          
        };

        //add partStatus_meyer in Product table
        await prisma.product.update({
          where: {
            sku: product.sku,
          },
          data: {
            partStatus_meyer: data[0].PartStatus,
            meyer_length: data[0].Length,
            meyer_width: data[0].Width,
            meyer_height: data[0].Height,
            meyer_weight: data[0].Weight,
          },
        });

        vendorProductCreatedCount++; // Increment the created count
        // Create the vendor product
        await prisma.vendorProduct.create({
          data: vendorProductData,
        });

        // console.log("created vendor product from Meyer: ", vendorProductData);

      } catch (error) {
        console.error(`Error processing vendor_sku :`, error);
        // You can choose to continue to the next iteration or handle the error as needed
      }
    }

    console.log(`Meyer vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}`);

  } catch (error) {
    console.error("Error seeding vendor products from Meyer:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedMeyerVendorProducts();
module.exports = seedMeyerVendorProducts;

