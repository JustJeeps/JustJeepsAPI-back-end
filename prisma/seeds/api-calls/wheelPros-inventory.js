const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// US and CAD stock columns
const usStockColumns = ['1011', '1015', '1019', '1022', '1028', '1031', '1036', '1072', '1085', '1086', '1088'];
const cadStockColumns = ['4033', '4035'];

// Normalize SKU (PartNumber)
function normalizeSku(sku) {
  if (!sku) return '';
  let formattedSku = sku;

  if (formattedSku.startsWith('0000000000')) {
    formattedSku = formattedSku.replace(/^0+/, '');
  } else if (formattedSku.startsWith('SB')) {
    formattedSku = formattedSku.substring(2);
  } else if (formattedSku.startsWith('PXA')) {
    formattedSku = formattedSku.substring(3);
  } else if (formattedSku.startsWith('EXP')) {
    formattedSku = formattedSku.substring(3);
  } else if (formattedSku.startsWith('N') && formattedSku.includes('-')) {
    // Handle Nitto format like N205-770 -> 205770
    formattedSku = formattedSku.substring(1).replace('-', '');
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

// Process each file
function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true
  });

  return records.map(row => ({
    ...row,
    formattedSku: normalizeSku(row.PartNumber),
    vendor_inventory_string: getStockString(row),
    vendor_inventory: getVendorInventory(row)
  }));
}

// Log 20 sample records
function logSamples(records, label) {
  console.log(`\n📦 Previewing 20 SKUs from: ${label}`);
  records.slice(0, 20).forEach((row, i) => {
    console.log(`\n--- ${label} Record ${i + 1} ---`);
    console.log(`Original PartNumber: ${row.PartNumber}`);
    console.log(`Formatted SKU: ${row.formattedSku}`);
    console.log(`Brand: ${row.Brand || 'N/A'}`);
    console.log(`vendor_inventory_string: ${row.vendor_inventory_string}`);
    console.log(`vendor_inventory: ${row.vendor_inventory}`);
  });
}

// Process files
const accessories = processFile(path.resolve(__dirname, 'accessoriesInvPriceData.csv'));
const tires = processFile(path.resolve(__dirname, 'tireInvPriceData.csv'));
const wheels = processFile(path.resolve(__dirname, 'wheelInvPriceData.csv'));

// Show sample output
logSamples(accessories, 'Accessories');
logSamples(tires, 'Tires');
logSamples(wheels, 'Wheels');

// Combine and write to CSV
const combined = [...accessories, ...tires, ...wheels];
const output = stringify(combined, { header: true });
const outputPath = path.resolve(__dirname, 'wheelpros_enriched_output.csv');
fs.writeFileSync(outputPath, output);

console.log(`\n✅ Finished! Output saved as ${outputPath}`);
