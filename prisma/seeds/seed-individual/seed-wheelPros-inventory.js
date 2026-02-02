const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const prisma = require("../../../lib/prisma");
const VENDOR_ID = 5; // WheelPros

// US and CAD stock columns
const usStockColumns = ["1011", "1015", "1019", "1022", "1028", "1031", "1036", "1072", "1085", "1086", "1088"];
const cadStockColumns = ["4033", "4035"];

// Normalize SKU (PartNumber)
function normalizeSku(sku) {
  if (!sku) return "";
  let formattedSku = sku;

  if (formattedSku.startsWith("0000000000")) {
    formattedSku = formattedSku.replace(/^0+/, "");
  } else if (formattedSku.startsWith("SB")) {
    formattedSku = formattedSku.substring(2);
  } else if (formattedSku.startsWith("PXA")) {
    formattedSku = formattedSku.substring(3);
  } else if (formattedSku.startsWith("EXP")) {
    formattedSku = formattedSku.substring(3);
  } else if (formattedSku.startsWith("N") && formattedSku.includes("-")) {
    // Handle Nitto format like N205-770 -> 205770
    formattedSku = formattedSku.substring(1).replace("-", "");
  }

  return formattedSku;
}

// Calculate stock string
function getStockString(row) {
  const usTotal = usStockColumns.reduce((sum, col) => sum + (parseInt(row[col]) || 0), 0);
  const cadTotal = cadStockColumns.reduce((sum, col) => sum + (parseInt(row[col]) || 0), 0);
  return `CAD stock: ${cadTotal} / US stock: ${usTotal}`;
}

// Get vendor inventory from TotalQOH
function getVendorInventory(row) {
  return parseInt(row.TotalQOH) || 0;
}

// Process each file into enriched inventory rows (in-memory)
function processFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing WheelPros CSV file: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  });

  console.log(`📄 Loaded ${records.length} rows from ${filePath}`);

  return records.map((row) => ({
    ...row,
    formattedSku: normalizeSku(row.PartNumber),
    vendor_inventory_string: getStockString(row),
    vendor_inventory: getVendorInventory(row),
  }));
}

// Load raw WheelPros CSVs and build enriched inventory in memory
const dataDir = path.resolve(__dirname, "../api-calls");
const enrichedInventory = [
  ...processFile(path.resolve(dataDir, "accessoriesInvPriceData.csv")),
  ...processFile(path.resolve(dataDir, "tireInvPriceData.csv")),
  ...processFile(path.resolve(dataDir, "wheelInvPriceData.csv")),
];

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
        missingCount++;
        continue;
      }

      console.log(`✅ Found vendor product for SKU: ${vendorSku}`);

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
