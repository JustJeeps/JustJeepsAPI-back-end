const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const prisma = require("../../../lib/prisma");
const VENDOR_ID = 5; // WheelPros

// Load enriched inventory CSV using absolute path
const csvPath = path.resolve(__dirname, "../api-calls/wheelpros_enriched_output.csv");

const enrichedInventory = parse(
  fs.readFileSync(csvPath, "utf-8"),
  {
    columns: true,
    skip_empty_lines: true,
  }
);

// Helper: Get vendor product by vendor_sku (PartNumber)
const updateInventory = async () => {
  let updatedCount = 0;
  let missingCount = 0;

  console.log("🔄 Updating WheelPros vendor inventory...");

  for (const row of enrichedInventory) {
    const vendorSku = row.PartNumber;
    const vendor_inventory_string = row.vendor_inventory_string || null;
    const vendor_inventory = row.vendor_inventory
      ? parseInt(row.vendor_inventory)
      : null;

    try {
      const vendorProduct = await prisma.vendorProduct.findFirst({
        where: {
          vendor_sku: vendorSku,
          vendor_id: VENDOR_ID,
        },
      });

      if (!vendorProduct) {
        console.warn(`⚠️ Vendor product not found for SKU: ${vendorSku}`);
        missingCount++;
        continue;
      }

      await prisma.vendorProduct.update({
        where: {
          id: vendorProduct.id,
        },
        data: {
          vendor_inventory,
          vendor_inventory_string,
        },
      });

      updatedCount++;
      
      // Log progress every 500 products
      if (updatedCount % 5 === 0) {
        console.log(`📦 Progress: ${updatedCount} products updated, ${missingCount} missing...`);
      }
    } catch (error) {
      console.error(`❌ Error updating SKU ${vendorSku}:`, error);
    }
  }

  console.log(`\n✅ Done!
  ➕ Updated: ${updatedCount}
  ❌ Missing SKUs: ${missingCount}`);

  await prisma.$disconnect();
};

updateInventory();
