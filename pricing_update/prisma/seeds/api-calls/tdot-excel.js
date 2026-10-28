const XLSX = require("xlsx");
const path = require("path");

const tdotPrice = () => {
  // Step 1: Load Excel file
  const filePath = path.join(__dirname, "tdot-excel.xlsx");
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Use header: 1 to get raw rows (including the first header row)
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Step 3: Process JSON Data, skip the header row (index 0)
  // const finalResults = jsonData
  //   .slice(1) // Skip the first row (headers)
  //   .map((row, index) => {
  //     return {
  //       tdot_price: row[2], // 'list1_title_price' is in the 3rd column (index 2)
  //       tdot_code: row[3],   // 'tdot_code' is in the 4th column (index 3)
      
      
      
  //     };
    // });

  const finalResults = jsonData
  .slice(1) // Skip the first row (headers)
  .map((row) => {
    let tdot_code = row[3];

    // Only modify if it starts with "Bestop " and contains a dash
    if (typeof tdot_code === "string" && tdot_code.startsWith("Bestop ")) {
      tdot_code = tdot_code.replace(/(\d+)-(\d+)/, "$1$2");
    }

    return {
      tdot_price: row[2], // 3rd column
      tdot_code: tdot_code, // modified or original
    };
  });


  console.log("Processed Results (first 10 rows):", finalResults.slice(0, 10));
  console.log(`Total rows processed: ${finalResults.length}`);
  return finalResults; // Ensure this returns the processed data
};

if (require.main === module) {
  tdotPrice();
}

module.exports = tdotPrice;
