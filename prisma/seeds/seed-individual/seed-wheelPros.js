const { PrismaClient } = require("@prisma/client");
const {
  getAuthToken,
  getWheelProsSkus,
  makeApiRequestsInChunks,
} = require("../api-calls/wheelPros-api.js");

const prisma = new PrismaClient();

const seedWheelProsProducts = async () => {
  console.log("🚀 Seeding WheelPros vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // ✅ Step 0: Clear old vendor products for WheelPros
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: 5 } });
    console.log("🗑️ Deleted all existing WheelPros vendor products (vendor_id = 5)");

    // ✅ Step 1: Get token and SKUs
    const token = await getAuthToken();
    const skus = await getWheelProsSkus();

    // ✅ Step 2: Fetch vendor product data
    const vendorProductsData = await makeApiRequestsInChunks(token, skus, 50);
    console.log(`🔍 API returned ${vendorProductsData.length} vendor products`);


    // ✅ Process each vendor product
    // ✅ Process each vendor product
    for (const data of vendorProductsData) {
      const vendorCost = parseFloat(data.prices?.nip?.[0]?.currencyAmount);
      const mapPrice   = parseFloat(data.prices?.map?.[0]?.currencyAmount);

      console.log(
        `🔍 Processing SKU: ${data.sku} | Cost: ${isNaN(vendorCost) ? "❌ NaN" : vendorCost} | MAP: ${isNaN(mapPrice) ? "❌ NaN" : mapPrice}`
      );

      try {
        // ✅ Check if vendor product already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: { vendor_sku: data.sku, vendor_id: 5 },
        });

        if (existingVendorProduct) {
          vendorProductUpdatedCount++;

          if (!isNaN(vendorCost)) {
            await prisma.vendorProduct.update({
              where: { id: existingVendorProduct.id },
              data: { vendor_cost: vendorCost },
            });
          } else {
            console.warn(`⚠️ Skipping vendor cost update for SKU: ${data.sku} (invalid cost)`);
          }

          if (!isNaN(mapPrice)) {
            await prisma.product.update({
              where: { sku: existingVendorProduct.product_sku },
              data: { MAP: mapPrice },
            });
          } else {
            console.warn(`⚠️ Skipping MAP update for SKU: ${data.sku} (invalid MAP)`);
          }

          continue; // move to next SKU
        }

        // ✅ Normalize SKU for lookup
        let formattedSku = data.sku;
        if (data.sku.startsWith("0000000000")) formattedSku = data.sku.replace(/^0+/, "");
        if (data.sku.startsWith("SB")) formattedSku = data.sku.substring(2);
        if (data.sku.startsWith("PXA")) formattedSku = data.sku.substring(3);
        if (data.sku.startsWith("EXP")) formattedSku = data.sku.substring(3);
        if (data.sku.startsWith("N") && /^\d{3}-\d{3}$/.test(data.sku.substring(1)))
          formattedSku = data.sku.substring(1).replace("-", "");

        const product = await prisma.product.findFirst({
          where: { searchable_sku: formattedSku },
        });

        if (!product) {
          console.error(`❌ Product not found for WheelPros sku: ${data.sku}`);
          continue;
        }

        // ✅ Create vendorProduct only if cost is valid
        if (!isNaN(vendorCost)) {
          await prisma.vendorProduct.create({
            data: {
              product_sku: product.sku,
              vendor_id: 5,
              vendor_sku: data.sku,
              vendor_cost: vendorCost,
            },
          });
          vendorProductCreatedCount++;
        } else {
          console.warn(`⚠️ Skipping vendor product creation for SKU: ${data.sku} (invalid cost)`);
        }

        // ✅ Update MAP only if valid
        if (!isNaN(mapPrice)) {
          await prisma.product.update({
            where: { sku: product.sku },
            data: { MAP: mapPrice },
          });
        } else {
          console.warn(`⚠️ Skipping MAP update for SKU: ${data.sku} (invalid MAP)`);
        }

      } catch (err) {
        console.error(`❌ Failed to process SKU: ${data.sku}`);
        console.error(`   ↳ Reason: ${err.message}`);
      }
    }


    console.log(`✅ WheelPros vendor products seeded successfully!
      ➕ Created: ${vendorProductCreatedCount}
      🔄 Updated: ${vendorProductUpdatedCount}`);
  } catch (err) {
    console.error("❌ Error seeding vendor products from WheelPros:", err.message);
  } finally {
    await prisma.$disconnect();
  }
};

seedWheelProsProducts();
module.exports = seedWheelProsProducts;



// const { PrismaClient } = require("@prisma/client");
// const {
//   getWheelProsSkus,
//   makeApiRequestsInChunks,
// } = require("../api-calls/wheelPros-api.js");

// const prisma = new PrismaClient();

// // Seed WheelPros products
// const seedWheelProsProducts = async () => {

  
//   console.log("Seeding WheelPros vendor products...");
//   try {
//     let vendorProductCreatedCount = 0;
//     let vendorProductUpdatedCount = 0;
    
//     // Call WheelPros API and get the processed responses
//     const skus = await getWheelProsSkus();
//     const vendorProductsData = await makeApiRequestsInChunks(skus, 50);

//     // Loop through the vendorProductsData array and create/update vendor products
//     for (const data of vendorProductsData) {
//       console.log(`data:`, data);
//       try {
//         // Check if a vendor product with the same vendor_sku already exists
//         const existingVendorProduct = await prisma.vendorProduct.findFirst({
//           where: {
//             vendor_sku: data.sku,
//             vendor_id: 5, // Replace with the appropriate vendor_id for WheelPros
//           },
//         });

//         if (existingVendorProduct) {
//           vendorProductUpdatedCount++; // Increment the updated count
//           // Update the existing vendor product with new data
//           await prisma.vendorProduct.update({
//             where: {
//               id: existingVendorProduct.id,
//             },
//             data: {
//               vendor_sku: data.sku,
//               vendor_cost: parseFloat(data.prices.nip[0].currencyAmount), // Convert to float              
//               // Add any other fields that you want to update
//             },
//           });

//           //update the MAP in product table
//           await prisma.product.update({
//             where: {
//               sku: existingVendorProduct.product_sku,
//             },
//             data: {
//               MAP: parseFloat(data.prices.map[0].currencyAmount), // Convert to float
//               // Add any other fields that you want to update
//             },
//           });


//           continue; // Move to the next iteration
//         }

//         console.log(`Looking for product where searchable_sku endsWith: ${data.sku.replace(/^0+/, "")}`);

//         //NORMALIZE FORMAT FOR WHEELPROS SKUS

//         let formattedSku = data.sku;

//         // Remove leading zeros for TeraFlex
//         if (data.sku.startsWith("0000000000")) {
//           formattedSku = data.sku.replace(/^0+/, "");
//         }

//         // Remove SB prefix for Smittybilt
//         if (data.sku.startsWith("SB")) {
//           formattedSku = data.sku.substring(2);
//         }

//         // Remove PXA prefix for PRO COMP Alloy Wheels
//         if (data.sku.startsWith("PXA")) {
//           formattedSku = data.sku.substring(3);
//         }

//         // Remove EXP prefix for PRO COMP Suspension
//         if (data.sku.startsWith("EXP")) {
//           formattedSku = data.sku.substring(3);
//         }

//         // Remove N prefix and dash for Nitto Tire
//         if (data.sku.startsWith("N") && /^\d{3}-\d{3}$/.test(data.sku.substring(1))) {
//           formattedSku = data.sku.substring(1).replace("-", "");
//         }

//         // Retrieve the product_sku from the Product table using the WheelPros sku as reference
//         let product;
//         product = await prisma.product.findFirst({
//           where: {
//             // searchable_sku: data.sku, // Replace with the appropriate field for WheelPros
//             searchable_sku: formattedSku, // Use formattedSku to match searchable_sku
            
//           },
//         });

//         if (!product) {
//           console.error(`Product not found for WheelPros sku: ${data.sku}`);
//           continue; // Skip to the next iteration
//         }

//         // Update the data with the retrieved product_sku and vendor_id
//         const vendorProductData = {
//           product_sku: product.sku,
//           vendor_id: 5, // Replace with the appropriate vendor_id for WheelPros
//           vendor_sku: data.sku,
//           vendor_cost: parseFloat(data.prices.nip[0].currencyAmount), // Convert to float

//         };
//         vendorProductCreatedCount++; // Increment the created count
//         // Create the vendor product
//         await prisma.vendorProduct.create({
//           data: vendorProductData,
//         });

//         //update the MAP in product table
//         await prisma.product.update({
//           where: {
//             sku: product.sku,
//           },
//           data: {
//             MAP: parseFloat(data.prices.map[0].currencyAmount), // Convert to float
//             // Add any other fields that you want to update
//           },
//         });

//       } catch (error) {
//         console.error(`Error processing vendor_sku:`, error);
//         // You can choose to continue to the next iteration or handle the error as needed
//       }
//     }

//     console.log(`WheelPros vendor products seeded successfully! 
//       Total WheelPros products created: ${vendorProductCreatedCount}
//       Total WheelPros products updated: ${vendorProductUpdatedCount}`);
//   } catch (error) {
//     console.error("Error seeding vendor products from WheelPros:", error);
//   } finally {
//     await prisma.$disconnect();
//   }
// };

// seedWheelProsProducts();
// module.exports = seedWheelProsProducts;



