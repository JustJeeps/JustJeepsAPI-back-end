const XLSX = require("xlsx");
const path = require("path");

const quadratecInventory = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "quadratec_wholesale.xlsx");

  // Read the file using the updated file path
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
  const sheet = workbook.Sheets[sheetName];

  // Define custom header array
  const customHeader = [
    "Quadratec Part No",
    "Part No",
    "Description",
    "Brand",
    "Inventory PA1",
    "Inventory PA2",
    "Inventory NV1",  
    "Inventory Total",
    "Cost",
    "Surcharge",
    "UPC",
    "MAP",

  ];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

  // Step 3: Access JSON Data
  const finalResults = jsonData.slice(1).map((obj) => {
    let quadratecCode;
    if (
      obj["Brand"] === "Quadratec" ||
      obj["Brand"] === "QuadraTop" ||
      obj["Brand"] === "TACTIK" ||
      obj["Brand"] === "Tecstyle" ||
      obj["Brand"] === "Diver Down" ||
      obj["Brand"] === "RES-Q" ||
      obj["Brand"] === "Lynx" ||
      obj["Brand"] === "Tom Woods"
    ) {
      quadratecCode = obj["Brand"].toString() + obj["Quadratec Part No"].toString();
    } else {
      quadratecCode = obj["Brand"] && obj["Part No"]
      ? obj["Brand"].toString() + obj["Part No"].toString()
      : null;
    }
    return {
      MPN: obj["Part No"].toString(),
      brand: obj["Brand"],
      wholesalePrice: obj["Cost"],
      quadratec_code: quadratecCode,
      quadratec_sku: obj["Quadratec Part No"].toString(),
      quadratec_inventory: obj["Inventory Total"],
    };
  });

  // const finalResults = jsonData
  //   .slice(1)
  //   .map((obj) => {
  //     return {
  //       "MPN": obj["MPN"].toString(),
  //       "brand": obj["Brand"],
  //       "wholesalePrice": obj["Wholesale Price"],
  //       "retailPrice": obj["Retail Price"],
  //       "quadratec_code": obj["Brand"].toString() + obj["MPN"].toString()

  //     };
  //   });
  console.log(finalResults);
  return finalResults;
};

quadratecInventory();

module.exports = quadratecInventory;
