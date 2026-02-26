const fetchOmixInventory = require('../api-calls/omix-inventory-api');

const prisma = require('../../../lib/prisma');

function buildInventoryUpdate(existingVendorProduct, rawInventory) {
  const isOutOfStock =
    rawInventory === undefined ||
    rawInventory === null ||
    typeof rawInventory !== 'string' ||
    rawInventory.toLowerCase().includes('out');

  if (isOutOfStock) {
    const nextInventoryString = rawInventory || 'Out of Stock';
    const needsInventoryNull = existingVendorProduct.vendor_inventory !== null;
    const needsStringUpdate =
      existingVendorProduct.vendor_inventory_string !== nextInventoryString;

    if (!needsInventoryNull && !needsStringUpdate) return null;

    return {
      vendor_inventory_string: nextInventoryString,
      vendor_inventory: needsInventoryNull ? null : existingVendorProduct.vendor_inventory,
    };
  }

  const inventory = parseFloat(rawInventory);

  if (!isNaN(inventory)) {
    const needsInventoryUpdate = existingVendorProduct.vendor_inventory !== inventory;
    const needsStringNull = existingVendorProduct.vendor_inventory_string !== null;

    if (!needsInventoryUpdate && !needsStringNull) return null;

    return {
      vendor_inventory: inventory,
      vendor_inventory_string: null,
    };
  }

  const needsStringUpdate =
    existingVendorProduct.vendor_inventory_string !== rawInventory;
  const needsInventoryNull = existingVendorProduct.vendor_inventory !== null;

  if (!needsStringUpdate && !needsInventoryNull) return null;

  return {
    vendor_inventory_string: rawInventory,
    vendor_inventory: null,
  };
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const maxWorkers = Math.min(limit, items.length);
  const workers = Array.from({ length: maxWorkers }, async () => {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) break;
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
}

async function seedOmixInventory() {
  const startTimeMs = Date.now();
  console.time('omixInventorySeed');
  try {
    let vendorProductUpdatedCount = 0;

    const inventoryData = await fetchOmixInventory();

    const inventoryLinks = Array.isArray(inventoryData?.links)
      ? inventoryData.links
      : [];
    if (inventoryLinks.length === 0) {
      console.warn('⚠️ No Omix inventory links returned.');
      return;
    }

    const skus = inventoryLinks
      .map((item) => item?.sku)
      .filter((sku) => typeof sku === 'string' && sku.length > 0);

    const vendorProducts = await prisma.vendorProduct.findMany({
      where: {
        vendor_id: 3,
        vendor_sku: { in: skus },
      },
      select: {
        id: true,
        vendor_sku: true,
        vendor_inventory: true,
        vendor_inventory_string: true,
      },
    });

    const vendorProductBySku = new Map(
      vendorProducts.map((product) => [product.vendor_sku, product])
    );

    await runWithConcurrency(inventoryLinks, 15, async (item) => {
      const sku = item?.sku;
      if (typeof sku !== 'string' || sku.length === 0) return;

      const existingVendorProduct = vendorProductBySku.get(sku);
      if (!existingVendorProduct) return;

      const rawInventory = item?.inventory;
      const updateData = buildInventoryUpdate(existingVendorProduct, rawInventory);
      if (!updateData) return;

      await prisma.vendorProduct.update({
        where: { id: existingVendorProduct.id },
        data: updateData,
      });

      vendorProductUpdatedCount++;
    });

    console.log(`✅ Omix inventory updated. Total updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error('❌ Error seeding Omix inventory:', error);
  } finally {
    console.timeEnd('omixInventorySeed');
    const durationMs = Date.now() - startTimeMs;
    console.log(`⏱️ Omix inventory seed completed in ${durationMs}ms`);
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
