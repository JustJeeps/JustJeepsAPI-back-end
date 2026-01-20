const XLSX = require("xlsx");
const path = require("path");

const aevCost = () => {
  const filePath = path.join(__dirname, "AEV-price-file.xlsx");
  const workbook = XLSX.readFile(filePath);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Read with headers from the first row
  const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const finalResults = jsonData
    .filter(row => row["Manufacturer SKU"] && row["Dealer+ Price"])
    .map(row => ({
      Item: row["Manufacturer SKU"].toString().trim(),
      Cost: row["Dealer+ Price"],
    }));

  console.log(finalResults);
  return finalResults;
};

aevCost();

module.exports = aevCost;
