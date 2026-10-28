const XLSX = require("xlsx");
const path = require("path");

const curtCost = () => {
  const filePath = path.join(__dirname, "curt-price-file.xlsx");
  const workbook = XLSX.readFile(filePath);

  const sheetName = workbook.SheetNames[0]; // "Customer Item Prices"
  const sheet = workbook.Sheets[sheetName];

  // Read with headers from the second row (index 1) since first row is title
  const jsonData = XLSX.utils.sheet_to_json(sheet, { 
    range: 1, // Start from row 2 (0-indexed)
    defval: "" 
  });

  // ONLY extract these 4 brands as specified by the user
  const targetBrands = [
    "ARIES Automotive",
    "CURT Manufacturing", 
    "LUVERNE Truck Equipment",
    "UWS Storage Solutions"
  ];

  const finalResults = jsonData
    .filter(row => {
      // Filter to only include the 4 target brands
      const brandName = row["Brand Name"] ? row["Brand Name"].toString().trim() : "";
      return targetBrands.includes(brandName);
    })
    .filter(row => row["Item Number"] && row["Price"]) // Ensure required fields exist
    .map(row => ({
      BrandName: row["Brand Name"] ? row["Brand Name"].toString().trim() : "",
      Item: row["Item Number"].toString().trim(),
      ItemDescription: row["Item Description"] ? row["Item Description"].toString().trim() : "",
      Cost: parseFloat(row["Price"]) || 0,
      Jobber: parseFloat(row["Jobber"]) || 0,
      MAP: parseFloat(row["MAP"]) || 0,
      List: parseFloat(row["List"]) || 0,
      Weight: parseFloat(row["Weight"]) || 0,
      UPC: row["UPC"] ? row["UPC"].toString().trim() : ""
    }));

  // Group by brand for easier viewing
  const groupedResults = {};
  finalResults.forEach(item => {
    if (!groupedResults[item.BrandName]) {
      groupedResults[item.BrandName] = [];
    }
    groupedResults[item.BrandName].push(item);
  });

  console.log("Results grouped by brand:");
  Object.keys(groupedResults).forEach(brand => {
    console.log(`\n${brand}: ${groupedResults[brand].length} items`);
    // Show first few items as sample
    console.log("Sample items:", groupedResults[brand].slice(0, 3));
  });

  console.log(`\nTotal items extracted: ${finalResults.length}`);
  return finalResults;
};

// If running directly, execute the function
if (require.main === module) {
  curtCost();
}

module.exports = curtCost;