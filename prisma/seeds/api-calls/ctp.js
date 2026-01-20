const XLSX = require("xlsx");
const path = require("path");

// 1. Load CTP Excel inventory
const ctpInventory = async () => {
  const filePath = path.join(__dirname, "CTPENT_Inventory.xlsx");
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  console.log("Loaded file:", filePath);
  console.log("Sheet names:", workbook.SheetNames);

  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
  });

  const finalResults = jsonData
    .filter((row) => row["BrandName"] && row["SupplierCode"] && row["JobberPrice"])
    .map((row) => {
      const item = `${row["BrandName"].toString().trim()}${row["SupplierCode"].toString().trim()}`;
      const qty = parseInt(row["QtyAvailable"]) || 0;
      const cost = parseFloat(row["JobberPrice"]);
      return {
        Item: item,
        Inventory: qty,
        Cost: cost,
      };
    });

  console.log(finalResults);
  return finalResults;
};

module.exports = ctpInventory;

// To test it directly
if (require.main === module) {
  ctpInventory();
}
