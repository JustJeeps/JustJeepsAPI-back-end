const XLSX = require("xlsx");
const path = require("path");
const fetch = require("node-fetch");
const csv = require("csv-parser");
const { Readable } = require("stream");

// 1. Get inventory from Google Sheets
const getInventoryMap = async () => {
  const url =
    "https://docs.google.com/spreadsheets/d/1btYTQKkMjDnol_DiKVyMVv5zzA8H-Mcx8NAbf85w5Uk/export?format=csv&gid=1864232301";
  const inventoryMap = new Map();

  const response = await fetch(url);
  const csvBuffer = await response.buffer();

  await new Promise((resolve, reject) => {
    Readable.from(csvBuffer)
      .pipe(csv())
      .on("data", (row) => {
        const item = row["Item"]?.trim();
        const stock = row["Stock"]?.trim();
        if (item && stock) {
          inventoryMap.set(item, stock); // e.g., "In Stock", "Out of Stock"
        }
      })
      .on("end", resolve)
      .on("error", reject);
  });

  return inventoryMap;
};

// 2. Combine price and inventory
const keypartsCost = async () => {
  const filePath = path.join(__dirname, "KeyParts-price-file.xlsx");
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets["Price List"];

  console.log("Loaded file:", filePath);
  console.log("Sheet names:", workbook.SheetNames);

  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    range: 6, // Start from row 7 where headers are
    defval: "",
  });

  const inventoryMap = await getInventoryMap();

  const finalResults = jsonData
    .filter((row) => row["Item"] && row["Unit Price"])
    .map((row) => {
      const item = row["Item"].toString().trim();
      const cost = parseFloat(row["Unit Price"]);
      const inventory = inventoryMap.get(item) || null;
      return {
        Item: item,
        Cost: cost,
        Inventory: inventory,
      };
    });

  console.log(finalResults);
  return finalResults;
};

module.exports = keypartsCost;

// To test it directly
if (require.main === module) {
  keypartsCost();
}
