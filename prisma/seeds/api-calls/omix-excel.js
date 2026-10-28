const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const omixCost = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "omix-excel.xlsx");

  // Say what to do about it. Without this the nightly failure reads
  // "ENOENT: no such file or directory, open '/app/prisma/seeds/api-calls/
  // omix-excel.xlsx'", which is a container path nobody can act on, and the
  // file has been missing for weeks precisely because nothing said how to
  // put it back.
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "No Omix price sheet available. Upload omix-excel.xlsx in Settings > Imports (Omix price sheet), or run: npm run feed-upload -- omix <file>"
    );
  }

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
  console.log(`Omix rows loaded: ${finalResults.length}`);
  return finalResults;
};

// omixCost();

module.exports = omixCost;
