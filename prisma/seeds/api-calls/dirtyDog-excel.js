const XLSX = require("xlsx");
const path = require("path");

const dirtyDogCost = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "dirtyDog-excel.xlsx");

  // Read the file using the updated file path
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
  const sheet = workbook.Sheets[sheetName];

  // Define custom header array
  const customHeader = [
    "Model Sort",
    "SKU",
    "UPC",
    "CAD Price",
    "MSRP/MAP",
    "Just Jeeps cost",
  ];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

  // Step 3: Access JSON Data
  const finalResults = jsonData
    .slice(1)
    .map((obj) => {
      return {
        SKU: obj["SKU"],
        "Just Jeeps cost": obj["Just Jeeps cost"],
        MAP: obj["MSRP/MAP"],
      };
    });
  console.log(finalResults);
  return finalResults;
};

dirtyDogCost();


module.exports = dirtyDogCost;
