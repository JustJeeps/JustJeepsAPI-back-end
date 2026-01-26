const XLSX = require("xlsx");
const path = require("path");

const quadratecCost = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "pricingSheet_quad.xlsx");

  // Read the file using the updated file path
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
  const sheet = workbook.Sheets[sheetName];

  // Define custom header array
  const customHeader = [
    "Quadratec PN",
    "MPN",
    "Description",
    "UPC Code",
    "Brand",
    "Retail Price",
    "Wholesale Price",
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
      obj["Brand"] === "Tom Woods" ||
      obj["Brand"] === "Tru-Fit" ||
      obj["Brand"] === "Carnivore"

    ) {
      quadratecCode = obj["Brand"].toString() + obj["Quadratec PN"].toString();
    } else {
      quadratecCode = obj["Brand"].toString() + obj["MPN"].toString();
    }
    return {
      MPN: obj["MPN"].toString(),
      brand: obj["Brand"],
      wholesalePrice: obj["Wholesale Price"],
      retailPrice: obj["Retail Price"],
      quadratec_code: quadratecCode,
      quadratec_sku: obj["Quadratec PN"].toString(),
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

// Only run if called directly (not when imported)
if (require.main === module) {
  quadratecCost();
}

module.exports = quadratecCost;
