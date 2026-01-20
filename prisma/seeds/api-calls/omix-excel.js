const XLSX = require("xlsx");
const path = require("path");

const omixCost = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "omix-excel.xlsx");

  // Read the file using the updated file path
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
  const sheet = workbook.Sheets[sheetName];

  // Define custom header array
  const customHeader = [
    "Account#",
    "Desc",
    "Brand",
    "PF Desc",
    "Product Class",
    "Product Line",
    "Prefix",
    "Part Number",
    "Jobber",
    "Quoted Price",
    "Cust Item",
    "MAP",
    "MSRP",
    "UPC",
    "Mfg Co",
    "Origin",
    "Sch B",
  ];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

  // Step 3: Access JSON Data
  const finalResults = jsonData
    .slice(1)
    .filter((obj) => {
      const brand = obj["Brand"] ? obj["Brand"].trim() : "";
      return brand === "OMIX" || brand === "ALLOY" || brand === "RUGGED RIDGE" || brand === "HAVOC";
            // return brand === "ALLOY";
    })
    .map((obj) => {
      return {
        "Part Number": obj["Part Number"].toString(),
        "Quoted Price": obj["Quoted Price"],
      };
    });
  console.log(finalResults);
  return finalResults;
};

// omixCost();

module.exports = omixCost;
