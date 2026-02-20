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
    const brand = obj["Brand"]?.toString() || "";
    const mpn = obj["MPN"]?.toString() || "";
    const quadPn = obj["Quadratec PN"]?.toString() || "";

    const useQuadratecPnForBrand =
      brand === "Quadratec" ||
      brand === "QuadraTop" ||
      brand === "TACTIK" ||
      brand === "Tecstyle" ||
      brand === "Diver Down" ||
      brand === "RES-Q" ||
      brand === "Lynx" ||
      brand === "Tom Woods" ||
      brand === "Tru-Fit" ||
      brand === "Carnivore";

    // Some products for these brands use Quadratec PN, others use MPN.
    // Emit both codes so the seeder can match either.
    let quadratecCode = "";
    let quadratecCodeAlt = "";

    if (useQuadratecPnForBrand) {
      quadratecCode = brand + quadPn;
      if (mpn && mpn !== quadPn) {
        quadratecCodeAlt = brand + mpn;
      }
    } else {
      quadratecCode = brand + mpn;
      if (quadPn && quadPn !== mpn) {
        quadratecCodeAlt = brand + quadPn;
      }
    }

    return {
      MPN: mpn,
      brand,
      wholesalePrice: obj["Wholesale Price"],
      retailPrice: obj["Retail Price"],
      quadratec_code: quadratecCode,
      quadratec_code_alt: quadratecCodeAlt || null,
      quadratec_sku: quadPn,
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
  if (process.env.DEBUG_QUADRATEC_EXCEL === "1") {
    console.log("from api-calls", finalResults);
  }
  return finalResults;
};

// Only run if called directly (not when imported)
if (require.main === module) {
  quadratecCost();
}

module.exports = quadratecCost;
