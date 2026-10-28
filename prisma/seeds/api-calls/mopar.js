const XLSX = require("xlsx");
const path = require("path");

const moparCost = () => {
  const filePath = path.join(__dirname, "mopar-price-file.xlsx");
  const workbook = XLSX.readFile(filePath);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Read with headers from the first row
  const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const finalResults = jsonData
    .filter(row => row["MANUF. SKU"] && row["cost"])
    .map(row => ({
      Item: row["MANUF. SKU"].toString().trim(),
      Cost: row["cost"],
    }));

  console.log(finalResults);
  return finalResults;
};

moparCost();

module.exports = moparCost;
