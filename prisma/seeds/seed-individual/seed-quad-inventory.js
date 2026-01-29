const prisma = require('../../../lib/prisma');
const quadratecInventory = require('../api-calls/quad-inventory-api');

async function seedQuadInventory() {
  try {
    const inventoryData = await quadratecInventory();

    for (const data of inventoryData) {
      if (!data.quadratec_code) {
        console.warn(`Skipping entry with missing quadratec_code:`, data);
        continue;
      }

      const existingProduct = await prisma.vendorProduct.findFirst({
        where: {
          vendor_sku: data.quadratec_code,
          vendor_id: 4
        }
      });

      // if (existingProduct) {
      //   const hasNoInventoryInfo =
      //   (data.quadratec_inventory === null || data.quadratec_inventory === undefined) &&
      //   !data.vendor_inventory_string;
      
      //   const vendorInventoryString = hasNoInventoryInfo ? "no info" : data.vendor_inventory_string;
      
      
      //   await prisma.vendorProduct.update({
      //     where: { id: existingProduct.id },
      //     data: {
      //       vendor_inventory: data.quadratec_inventory,
      //       vendor_inventory_string: vendorInventoryString,
      //     },
      //   });
      
      //   console.log(
      //     `Updated inventory for vendor_sku: ${data.quadratec_code} | Inventory: ${data.quadratec_inventory} | Inventory String: ${vendorInventoryString}`
      //   );
      // }
      

      if (existingProduct) {
        await prisma.vendorProduct.update({
          where: { id: existingProduct.id },
          data: {
            vendor_inventory: data.quadratec_inventory,
          }
        });
        console.log(`Updated inventory for vendor_sku: ${data.quadratec_code}`);
      } else {
        // console.warn(`No existing product found for vendor_sku: ${data.quadratec_code}`);
      }
    }

    console.log('Quad inventory seeding completed.');
  } catch (error) {
    console.error('Error updating inventory:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedQuadInventory();
module.exports = seedQuadInventory;
