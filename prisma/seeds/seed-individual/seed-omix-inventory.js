const { PrismaClient } = require('@prisma/client');
const fetchOmixInventory = require('../api-calls/omix-inventory-api');

const prisma = new PrismaClient();

async function seedOmixInventory() {
  try {
    let vendorProductUpdatedCount = 0;

    const inventoryData = await fetchOmixInventory();

    for (const item of inventoryData.links) {
      const sku = item.sku;
      const rawInventory = item.inventory;

      const existingVendorProduct = await prisma.vendorProduct.findFirst({
        where: {
          vendor_sku: sku,
          vendor_id: 3,
        },
      });

      if (!existingVendorProduct) continue;

      const isOutOfStock =
        rawInventory === undefined ||
        rawInventory === null ||
        typeof rawInventory !== 'string' ||
        rawInventory.toLowerCase().includes('out');

      if (isOutOfStock) {
        // If previously had numeric inventory, clear it
        const updateData = {
          vendor_inventory_string: rawInventory || 'Out of Stock',
        };

        if (existingVendorProduct.vendor_inventory !== null) {
          updateData.vendor_inventory = null;
        }

        await prisma.vendorProduct.update({
          where: { id: existingVendorProduct.id },
          data: updateData,
        });
      } else {
        const inventory = parseFloat(rawInventory);

        if (!isNaN(inventory)) {
          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },
            data: {
              vendor_inventory: inventory,
              vendor_inventory_string: null,
            },
          });
        } else {
          // fallback if not numeric, store as string
          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },
            data: {
              vendor_inventory_string: rawInventory,
              vendor_inventory: null,
            },
          });
        }
      }

      vendorProductUpdatedCount++;
    }

    console.log(`✅ Omix inventory updated. Total updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error('❌ Error seeding Omix inventory:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedOmixInventory().catch((err) => {
  console.error('❌ Error during Omix inventory seeding:', err);
  process.exit(1);
});




// const { PrismaClient } = require('@prisma/client');
// const fetchOmixInventory = require('../api-calls/omix-inventory-api');

// const prisma = new PrismaClient();

// async function seedOmixInventory() {
//   try {
//     let vendorProductUpdatedCount = 0;

//     const inventoryData = await fetchOmixInventory();

//     console.log('Omix inventory data:', inventoryData);

//     for (const item of inventoryData.links) {
//       const sku = item.sku;

//       // Check if item.inventory exists and is valid before proceeding
//       if (item.inventory === undefined || item.inventory === null || typeof item.inventory !== 'string' || item.inventory == "Out of Stock") {
//         console.warn(`Invalid inventory data found for SKU ${sku}. Skipping.`);
//         console.log('Invalid item:', item); // Log the invalid item object
//         continue; // Skip to the next iteration
//       }

//       // Convert inventory to lowercase and parse to float
//       const inventory = item.inventory.toLowerCase() === 'out of inventory' ? 0 : parseFloat(item.inventory);

//       const existingVendorProduct = await prisma.vendorProduct.findFirst({
//         where: {
//           vendor_sku: sku,
//           vendor_id: 3, // Adjust vendor_id according to your schema
//         },
//       });

//       if (existingVendorProduct) {
//         await prisma.vendorProduct.update({
//           where: { id: existingVendorProduct.id },
//           data: { vendor_inventory: inventory }
//         });
//         vendorProductUpdatedCount++;
//       } else {
//         // console.warn(`Vendor product with SKU ${sku} not found. Skipping update.`);
//       }
//     }

//     console.log(`Omix inventory updated successfully for existing products. 
//       Total vendor products updated: ${vendorProductUpdatedCount}`);

//   } catch (error) {
//     console.error('Error seeding Omix inventory:', error);
//   } finally {
//     await prisma.$disconnect();
//   }
// }

// // Execute the seeding function
// seedOmixInventory()
//   .catch(err => {
//     console.error('Error during Omix inventory seeding:', err);
//     process.exit(1); // Exit with non-zero code to indicate failure
//   });
