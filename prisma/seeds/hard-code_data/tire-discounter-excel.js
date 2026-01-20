const XLSX = require("xlsx");
const path = require("path");

const tireDiscounterCost = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "tire-discounter-excel.xlsx");

  // Read the file using the updated file path
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
  const sheet = workbook.Sheets[sheetName];

  // Define custom header array
  const customHeader = [
    "Item",
    "Manufacturer",
    "Description",
    "Size",
    "List",
    "Cost",
    "ProductTypeDescription",
  ];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

  // Step 3: Access JSON Data
  const finalResults = jsonData
  .slice(1)
  .filter((obj) => {
    const brand = obj["Manufacturer"] ? obj["Manufacturer"].trim() : "";
    return brand === "FIRESTONE" || brand === "Firestone" ||brand === "BRIDGESTONE" ||brand === "Bridgestone"|| brand === "BF GOODRICH" || brand === "BF Goodrich"|| brand === "MICHELIN" || brand === "Michelin"|| brand === "YKW" || brand === "Falken" || brand === "FALKEN"|| brand === "Nitto" || brand === "NITTO" ;
  })
  .map((obj) => {
    let item = obj["Item"].toString();
    const spaceIndex = item.indexOf(" ");
    if (spaceIndex !== -1) {
      item = item.substr(spaceIndex + 1);
    }
    return {
      "Item": item,
      "Cost": obj["Cost"],
    };
  });
  console.log(finalResults);
  return finalResults;
};

tireDiscounterCost();

module.exports = tireDiscounterCost;
