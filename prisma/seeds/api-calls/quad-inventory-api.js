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
    const brand = obj["Brand"]?.toString() || "";
    const partNo = obj["Part No"]?.toString() || "";
    const quadPartNo = obj["Quadratec Part No"]?.toString() || "";

    const useQuadratecPnForBrand =
      brand === "Quadratec" ||
      brand === "QuadraTop" ||
      brand === "TACTIK" ||
      brand === "Tecstyle" ||
      brand === "Diver Down" ||
      brand === "RES-Q" ||
      brand === "Lynx" ||
      brand === "Tom Woods";

    // Some products for these brands use Quadratec Part No, others use Part No.
    // Emit both codes so downstream can match either.
    let quadratecCode = "";
    let quadratecCodeAlt = "";

    if (useQuadratecPnForBrand) {
      quadratecCode = brand + quadPartNo;
      if (partNo && partNo !== quadPartNo) {
        quadratecCodeAlt = brand + partNo;
      }
    } else {
      quadratecCode = brand && partNo ? brand + partNo : "";
      if (quadPartNo && quadPartNo !== partNo) {
        quadratecCodeAlt = brand + quadPartNo;
      }
    }

    return {
      MPN: partNo,
      brand,
      wholesalePrice: obj["Cost"],
      quadratec_code: quadratecCode,
      quadratec_code_alt: quadratecCodeAlt || null,
      quadratec_sku: quadPartNo,
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
  // console.log("from api-calls", finalResults);
  return finalResults;
};

quadratecInventory();

module.exports = quadratecInventory;
