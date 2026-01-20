const axios = require("axios");
const fs = require("fs");
const { parse } = require("json2csv");

const config = {
  method: "get",
  maxBodyLength: Infinity,
  url: `https://www.parsehub.com/api/v2/projects/t84q4nt7WzTR/last_ready_run/data?api_key=t0UjHTnrieK_&format=json`,
  headers: {}
};

const tdotCost = async () => {
  console.log("🔄 Fetching data from ParseHub...");
  const response = await axios.request(config);
  const data = response.data?.list1;

  if (!Array.isArray(data)) {
    throw new Error("API returned unexpected format – 'list1' not found");
  }

  const results = [];

  data.forEach(item => {
    (item.title || []).forEach(t => {
      const name = t.name || "";
      const rawPrice = t.price || "";
      const price = parseFloat(rawPrice.replace("C$", "").replace(",", ""));

      const tdot_code = name.split(" -")[0].trim();
      const sku = tdot_code.split(" ").pop();
      const brand = tdot_code.replace(sku, "").trim();

      results.push({
        tdot_price: price,
        tdot_code,
        sku,
        brand,
        product_url: item.link || null
      });
    });
  });

  const unique = Object.values(
    results.reduce((acc, curr) => {
      acc[curr.tdot_code] = curr;
      return acc;
    }, {})
  );

  try {
    const csv = parse(unique, { fields: ["tdot_price", "tdot_code", "sku", "brand", "product_url"] });
    fs.writeFileSync("tdot-excel-automated.csv", csv);
    console.log(`📄 CSV saved as tdot-excel-automated.csv`);
  } catch (err) {
    console.warn("⚠️ Could not write CSV:", err.message);
  }

  console.log(`✅ Parsed ${unique.length} Tdot records`);
  return unique;
};

// ✅ Execute when run directly
(async () => {
  try {
    console.log("🚀 Running tdot-api.js...");
    const results = await tdotCost();
    console.log("🔍 First 10 results:", results.slice(0, 10));
    console.log(`✅ Processed ${results.length} unique rows`);
  } catch (err) {
    console.error("❌ Error in tdot-api.js:", err.message);
  } finally {
    console.log("🏁 Script finished");
  }
})();

module.exports = tdotCost;
