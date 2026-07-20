const XLSX = require("xlsx");
const loadWorkbook = require("./load-workbook");

// 1. Load CTP inventory (CTPENT_Inventory.csv preferred, .xlsx fallback)
const ctpInventory = async () => {
  const workbook = loadWorkbook("CTPENT_Inventory");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
  });

  const finalResults = jsonData
    .map((row) => {
      const brand = (row["BrandName"] ?? "").toString().trim();
      const supplierCode = (row["SupplierCode"] ?? "").toString().trim();
      const qty = parseInt(row["QtyAvailable"]) || 0;
      // parseFloat handles both xlsx numbers and CSV strings; !cost keeps the
      // original behavior of skipping rows with zero/missing jobber price.
      const cost = parseFloat(row["JobberPrice"]);
      if (!brand || !supplierCode || !cost) return null;
      return {
        Item: `${brand}${supplierCode}`,
        Inventory: qty,
        Cost: cost,
      };
    })
    .filter(Boolean);

  console.log(`CTP inventory rows: ${finalResults.length}`);
  return finalResults;
};

module.exports = ctpInventory;

// To test it directly
if (require.main === module) {
  ctpInventory();
}
