const XLSX = require("xlsx");
const path = require("path");

const alpineCost = () => {
  const filePath = path.join(__dirname, "alpine-price-file.xlsx");
  const workbook = XLSX.readFile(filePath);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Read with headers from the first row
  const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const finalResults = jsonData
    .filter(row => row["MODEL"] && row["*SPP Cost*"])
    .map(row => ({
      Item: row["MODEL"].toString().trim(),
      Cost: row["*SPP Cost*"],
    }));

  console.log(finalResults);
  return finalResults;
};

alpineCost();

module.exports = alpineCost;
