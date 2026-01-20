const axios = require("axios");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

const RoughCountryCost = async () => {
  try {
    // Step 1: Download Excel file from URL
    const url = "https://feeds.roughcountry.com/jobber_pc3.xlsx";
    const response = await axios({
      url: url,
      method: 'GET',
      responseType: 'arraybuffer' // Important: Fetch as arraybuffer to handle binary data
    });

    // Save the downloaded file to a temporary location
    const tempFilePath = path.join(__dirname, "temp_excel.xlsx");
    fs.writeFileSync(tempFilePath, response.data);

    // Step 2: Load Excel file
    const workbook = XLSX.readFile(tempFilePath);

    // Step 3: Extract Sheet Data
    const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
    const sheet = workbook.Sheets[sheetName];

    // Define custom header array based on your file structure
    const customHeader = [
      "sku",
      "availability",
      "NV_Stock",
      "TN_Stock",
      "link",
      "title",
      "description",
      "price",
      "sale_price",
      "special_from_date",
      "special_to_date",
      "cnd_map",
      "cost",
      // "image_1",
      // "image_2",
      // "image_3",
      // "image_4",
      // "image_5",
      // "image_6",
      // "video",
      // "features",
      // "notes",
      // "install_time",
      // "front_components",
      // "rear_components",
      // "instructions",
      // "fitment",
      // "tire_info",
      // "height",
      // "width",
      // "length",
      // "weight",
      // "manufacturer",
      // "upc",
      // "category",
      // "discount",
      // "multiple_box",
      // "shipping_group",
      // "coo",
      // "tariff_code",
      // "utv_product",
      // "added_date"
    ];

    // Convert sheet to JSON data
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

    // Log the entire jsonData to inspect what's being read
    console.log("JSON Data:", jsonData);

    // Step 4: Access JSON Data and format as needed
    const finalResults = jsonData.map((obj) => {
      // Debug output to inspect values
      // console.log("SKU:", obj["sku"], "Cost:", obj["cost"]);
      // console.log("SKU:", obj["sku"], "Cost:", obj["cost"], "TN_Stock:", obj["TN_Stock"], "MAP:", obj["cnd_map"]);

      return {
        SKU: obj["sku"],
        AVAILABILITY: obj["availability"],
        TN_STOCK: obj["TN_Stock"],
        MAP: obj["cnd_map"],
        COST: parseFloat(obj["cost"]), // Ensure to convert to number if needed
   
      };
    });

    // console.log(finalResults); // Output the formatted results to console
    return finalResults; // Return the formatted results
  } catch (error) {
    console.error("Error fetching or processing the Excel file:", error);
  }
};

// Call the function to execute
RoughCountryCost();

// Export the function for external use if needed
module.exports = RoughCountryCost;






//USE THIS FILE TO READ EXCEL FILE AND CONVERT TO JSON

// const XLSX = require("xlsx");
// const path = require("path");

// const RoughCountryCost = () => {
//   // Step 1: Load Excel file
//   const filePath = path.join(__dirname, "roughCountry-excel.xlsx");
//   const workbook = XLSX.readFile(filePath);

//   // Step 2: Extract Sheet Data
//   const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
//   const sheet = workbook.Sheets[sheetName];

//   // Define custom header array based on your file structure
//   const customHeader = [
//     "sku",
//     "availability",
//     "NV_Stock",
//     "TN_Stock",
//     "link",
//     "title",
//     "description",
//     "price",
//     "sale_price",
//     "cnd_map",
//     "cost",
//     "image_1",
//     "image_2",
//     "image_3",
//     "image_4",
//     "image_5",
//     "image_6",
//     "video",
//     "features",
//     "notes",
//     "install_time",
//     "front_components",
//     "rear_components",
//     "instructions",
//     "fitment",
//     "tire_info",
//     "height",
//     "width",
//     "length",
//     "weight",
//     "manufacturer",
//     "upc",
//     "category",
//     "discount",
//     "multiple_box",
//     "shipping_group",
//     "coo",
//     "tariff_code",
//     "utv_product",
//     "added_date"
//     // Add more headers as needed
//   ];

//   // Convert sheet to JSON data
//   const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

//   // Log the entire jsonData to inspect what's being read
//   console.log("JSON Data:", jsonData);

//   // Step 3: Access JSON Data and format as needed
//   const finalResults = jsonData.map((obj) => {
//     // Debug output to inspect values
//     console.log("SKU:", obj["sku"], "Cost:", obj["cost"]);

//     return {
//       SKU: obj["sku"],
//       AVAILABILITY: obj["availability"],
//       NV_STOCK: obj["NV_Stock"],
//       TN_STOCK: obj["TN_Stock"],
//       LINK: obj["link"],
//       TITLE: obj["title"],
//       DESCRIPTION: obj["description"],
//       PRICE: obj["price"],
//       SALE_PRICE: obj["sale_price"],
//       MAP: obj["cnd_map"],
//       COST: parseFloat(obj["cost"]), // Ensure to convert to number if needed

//       // Add more fields as needed
//     };
//   });

//   console.log(finalResults); // Output the formatted results to console
//   return finalResults; // Return the formatted results
// };

// // Call the function to execute
// RoughCountryCost();

// // Export the function for external use if needed
// module.exports = RoughCountryCost;
