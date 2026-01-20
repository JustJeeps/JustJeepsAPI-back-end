const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const omixCost = require("../api-calls/omix-excel.js");

const VENDOR_ID = 3; // Omix

// seed Omix products
const seedOmix = async () => {
  try {
    // Call OmixAPI and get the processed responses
    const vendorProductsData = await omixCost();
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // // ✅ Optional: Clear old vendor products for Omix (dangerous in prod)
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } });
    // console.log("🗑️ Deleted all existing Omix vendor products (vendor_id = 3)");

    for (const data of vendorProductsData) {
      // Defensive reads
      const partNumber = data?.["Part Number"];
      const quotedRaw = data?.["Quoted Price"];

      if (!partNumber || quotedRaw == null) {
        // Skip malformed rows
        continue;
      }

      const quoted = Number(quotedRaw);
      if (Number.isNaN(quoted)) {
        // Skip rows with non-numeric price
        continue;
      }

      // Business rule: 1.5x multiplier
      const vendorCost = quoted * 1.5;

      // 1) Look up existing vendorProduct **scoped by vendor_id = 3**
      const existingVendorProduct = await prisma.vendorProduct.findFirst({
        where: {
          vendor_id: VENDOR_ID,
          vendor_sku: partNumber,
        },
      });

      if (existingVendorProduct) {
        vendorProductUpdatedCount++;

        await prisma.vendorProduct.update({
          where: { id: existingVendorProduct.id },
          data: {
            // Keep the record tied to vendor 3 and current SKU
            vendor_id: VENDOR_ID,
            vendor_sku: partNumber,
            vendor_cost: vendorCost,
            // If you also want to refresh product_sku mapping on update, uncomment:
            // product_sku: product?.sku,
          },
        });

        continue; // Move to next iteration
      }

      // 2) Map to Product via omix_code
      const product = await prisma.product.findFirst({
        where: { omix_code: partNumber },
      });

      if (!product) {
        // Product not found, skip creating vendorProduct
        continue;
      }

      // 3) Create new vendorProduct
      await prisma.vendorProduct.create({
        data: {
          product_sku: product.sku,
          vendor_id: VENDOR_ID,
          vendor_sku: partNumber,
          vendor_cost: vendorCost,
        },
      });

      vendorProductCreatedCount++;
    }

    console.log(
      `Vendor products from Omix seeded successfully!\n` +
      `  Total vendor products created: ${vendorProductCreatedCount}\n` +
      `  Total vendor products updated: ${vendorProductUpdatedCount}`
    );
  } catch (error) {
    console.error("Error seeding vendor products from Omix:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedOmix();
module.exports = seedOmix;





// const { PrismaClient } = require("@prisma/client");
// const prisma = new PrismaClient();
// const omixCost = require("../api-calls/omix-excel.js");

// // // seed Omix products
// const seedOmix = async () => {
//   try {
//     // Call OmixAPI and get the processed responses
//     const vendorProductsData = await omixCost();
//     let vendorProductCreatedCount = 0;
//     let vendorProductUpdatedCount = 0;

//     //  // ✅ Step 0: Clear old vendor products for Omix
//     // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 3 } });
//     // console.log("🗑️ Deleted all existing Omix vendor products (vendor_id = 3)");

//     // Loop through the vendorProductsData array and create vendor products
//     for (const data of vendorProductsData) {
//       console.log("data", data);

//       // Check if a vendor product with the same vendor_sku already exists
//       const existingCompetitorProduct = await prisma.vendorProduct.findFirst({
//         where: {
//           vendor_sku: data["Part Number"], // Update: Access 'Part Number' key from data object
//         },
//       });

//       console.log("existingCompetitorProduct", existingCompetitorProduct);

//       if (existingCompetitorProduct) {
//         vendorProductUpdatedCount++;
//         console.log(
//           `Vendor product with vendor_sku: ${data['Part Number']} already exists, updating...`
//         );

//         // Update the existing vendor product with new data
//         await prisma.vendorProduct.update({
//           where: {
//             id: existingCompetitorProduct.id, // assuming there's an 'id' field as the primary key
//           },
//           data: {
//             vendor_sku: data["Part Number"], // Update with new vendor_sku
//             vendor_cost: data["Quoted Price"]*1.5, // Update with new vendor_cost
//             // Add any other fields that you want to update
//           },
//         });

//         // console.log(
//         //   `Vendor product with vendor_sku: ${data['Part Number']} updated successfully`
//         // );
//         continue; // Move to next iteration
//       }

//       // Retrieve the product_sku from the Product table using meyer_code as reference
//       let product; // Update: Declare product variable here
//       product = await prisma.product.findFirst({
//         where: {
//           omix_code: data["Part Number"], // Update: Access 'Part Number' key from data object
//         },
//       });
//       // console.log("product", product);

//       if (!product) {
//         // console.error(
//         //   `Product not found for omix_code: ${data['Part Number']}`
//         // );
//         continue;
//       }

//       // Update the data with the retrieved product_sku and vendor_id
//       const vendorProductData = {
//         product_sku: product.sku, // Updated with the correct product SKU',
//         vendor_id: 3, // Updated with the correct vendor ID
//         vendor_sku: data["Part Number"], // Extracted from API response
//         //2 decimal places for vendor_cost
//         vendor_cost: data["Quoted Price"]*1.5, // Extracted from API response
//         // vendor_cost: data["Quoted Price"]*1.40, // Extracted from API response
//         // Add any other fields that you want to create
//       };

//       // Create the vendor product
//       await prisma.vendorProduct.create({
//         data: vendorProductData,
//       });
//       vendorProductCreatedCount++;
//     }

//     // console.log("Vendor products from Omix seeded successfully!");
//     // console.log(`Total vendor products created: ${vendorProductCreatedCount}`);
//     // console.log(`Total vendor products updated: ${vendorProductUpdatedCount}`);
//     console.log(`Vendor products from Omix seeded successfully! 
//       Total vendor products created: ${vendorProductCreatedCount}, 
//       Total vendor products updated: ${vendorProductUpdatedCount}`);
//   } catch (error) {
//     console.error("Error seeding vendor products from Omix:", error);
//   } finally {
//     await prisma.$disconnect();
//   }
// };

// seedOmix();
// module.exports = seedOmix;