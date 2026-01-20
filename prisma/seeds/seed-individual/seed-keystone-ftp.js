const { PrismaClient } = require("@prisma/client");
const { performance } = require("perf_hooks");
const downloadAndParseKeystone = require("../api-calls/keystone-ftp.js");

const prisma = new PrismaClient();

const seedKeystone = async () => {
  console.log("🚀 Seeding Keystone vendor products (FTP)...");
  const startTime = performance.now();

  let vendorProductCreatedCount = 0;
  let vendorProductUpdatedCount = 0;
  let missingProductCount = 0;

  try {
    // ✅ Step 1: Download and parse *both* Keystone FTP files
    const keystoneFiles = await downloadAndParseKeystone();

    // Merge Inventory + SpecialOrder into one dataset
    const vendorProductsData = keystoneFiles.flatMap((f) => f.data || []);
    console.log(`📦 Total records to process: ${vendorProductsData.length}`);

    // // ✅ Step 0: Clear old vendor products for Keystone (after both files are merged)
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 1 } });
    // console.log("🗑️ Deleted all existing Keystone vendor products (vendor_id = 1)");

    // ✅ Step 2: Loop through merged data and insert fresh rows
    for (const data of vendorProductsData) {
      try {
        const keystoneCode = data.vcPn?.toString().trim();
        const vendorSkuRaw = data.partNumber?.toString().trim();

        if (!keystoneCode || !vendorSkuRaw) {
          console.warn("⚠️ Skipping row: missing vcPn or partNumber", { vcPn: data.vcPn, partNumber: data.partNumber });
          continue;
        }

        const product = await prisma.product.findFirst({
          where: { keystone_code: keystoneCode },
          select: { sku: true },
        });

        if (!product) {
          missingProductCount++;
          console.warn(`⚠️ Product not found for Keystone code: ${keystoneCode}`);
          continue;
        }

        const vendorCost = data.cost ? parseFloat(String(data.cost)) : null;
        const vendorInventory = data.totalQty ? parseInt(String(data.totalQty), 10) || 0 : 0;

        await prisma.vendorProduct.create({
          data: {
            product_sku: product.sku,
            vendor_id: 1,
            vendor_sku: vendorSkuRaw,
            vendor_cost: vendorCost,
            vendor_inventory: vendorInventory,
          },
        });
        vendorProductCreatedCount++;
      } catch (err) {
        console.error("❌ Error processing Keystone FTP row:", err.message);
      }
    }

    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`
✅ Keystone (FTP) seeding completed!
📊 Created: ${vendorProductCreatedCount}
📊 Updated (N/A since we cleared first): ${vendorProductUpdatedCount}
🧩 Missing product matches: ${missingProductCount}
⏱️ Time taken: ${duration} seconds
    `);
  } catch (error) {
    console.error("❌ Error seeding Keystone (FTP):", error);
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  seedKeystone();
}

module.exports = seedKeystone;



// const { PrismaClient } = require("@prisma/client");
// const { performance } = require("perf_hooks");
// const downloadAndParseKeystone = require("../api-calls/keystone-ftp.js");

// const prisma = new PrismaClient();

// const seedKeystone = async () => {
//   console.log("🚀 Seeding Keystone vendor products...");
//   const startTime = performance.now();

//   let vendorProductCreatedCount = 0;
//   let vendorProductUpdatedCount = 0;

//     //   // ✅ Step 0: Clear old vendor products for Keystone
//     // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 1 } });
//     // console.log("🗑️ Deleted all existing Keystone vendor products (vendor_id = 1)");

//   try {
//     // ✅ Step 1: Get parsed Keystone data from FTP
//     const keystoneFiles = await downloadAndParseKeystone();

//     // Merge Inventory + SpecialOrder into a single array
//     const vendorProductsData = keystoneFiles.flatMap(f => f.data);

//     console.log(`📦 Total records to process: ${vendorProductsData.length}`);

//     // ✅ Step 2: Loop through data
//     for (const data of vendorProductsData) {
//       try {
//         // 1️⃣ Find the product using vcPn → keystone_code
//         const product = await prisma.product.findFirst({
//           where: { 
//             keystone_code: data.vcPn 
//             // keystone_code: {
//             //   startsWith: "C1Y" // ✅ Only products with keystone_code starting with C1Y
//     }          // }
//         });

//         if (!product) {
//           console.warn(`⚠️ Product not found for Keystone code: ${data.vcPn}`);
//           continue;
//         }

//         // 2️⃣ Check if vendorProduct already exists
//         const existingVendorProduct = await prisma.vendorProduct.findFirst({
//           where: { product_sku: product.sku, vendor_id: 1 }
//         });

//         if (existingVendorProduct) {
//           // Update existing record
//           await prisma.vendorProduct.update({
//             where: { id: existingVendorProduct.id },
//             data: {
//               vendor_sku: data.partNumber,
//               vendor_cost: data.cost,
//               vendor_inventory: data.totalQty
//             }
//           });
//           vendorProductUpdatedCount++;
//           continue;
//         }

//         // 3️⃣ Create new vendorProduct
//         await prisma.vendorProduct.create({
//           data: {
//             product_sku: product.sku,
//             vendor_id: 1,
//             vendor_sku: data.partNumber,
//             vendor_cost: data.cost,
//             vendor_inventory: data.totalQty
//           }
//         });
//         vendorProductCreatedCount++;

//       } catch (err) {
//         console.error(`❌ Error processing Keystone code ${data.vcPn}:`, err.message);
//       }
//     }

//     // ✅ Step 3: Log summary
//     const endTime = performance.now();
//     const duration = ((endTime - startTime) / 1000).toFixed(2);

//     console.log(`
// ✅ Keystone vendor products seeded successfully!
// 📊 Created: ${vendorProductCreatedCount}
// 📊 Updated: ${vendorProductUpdatedCount}
// ⏱️ Time taken: ${duration} seconds
//     `);

//   } catch (error) {
//     console.error("❌ Error seeding Keystone vendor products:", error);
//   } finally {
//     await prisma.$disconnect();
//   }
// };

// seedKeystone();
// module.exports = seedKeystone;
