const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const fs = require("fs");

const prisma = new PrismaClient();

// Brand prefix mapping
const brandPrefixes = {
  "BF Goodrich Tires": "BF-",
  "Falken WildPeak": "FK-",
  "Nitto Tire": "NT-",
  "Yokohama": "YK-",
  "Bridgestone": "BS-",
  "Firestone": "FS-",
  "Michelin": "MI-",
  "Toyo Tires": "TY-",
  "Kumho": "KH-",
};

// 1. Get SKUs from database
const getTireDiscounterSkus = async () => {
  const skus = await prisma.product.findMany({
    where: {
      searchableSku: {
        not: "",
      },
      brand_name: {
        in: Object.keys(brandPrefixes),
      },
      status: 1,
    },
    select: {
      sku: true,
      brand_name: true,
    },
  });

  const results = skus.map(({ sku, brand_name }) => {
    const formatted = {
      ourSku: sku,
      theirSku: brandPrefixes[brand_name] + sku.split('-').slice(1).join('-'),
    };
    return formatted;
  });

  return results;
};

// 2. API Call
const fetchTireDiscounterData = async (theirSkus) => {
  const data = JSON.stringify({
    itemnumbers: theirSkus,
    partnumbers: [],
  });

  const config = {
    method: "post",
    maxBodyLength: Infinity,
    url: "https://www.tdgaccess.ca/api/inventory/search",
    headers: {
      Authorization: "ApiKey rst1b2Q09jYgsTDCvGhkP28EI7vU6KY4OI0ghCYPkrcGAc79WpQESP4XK7nhDvLAepgD",
      "Content-Type": "application/json",
    },
    data,
  };

  try {
    const response = await axios.request(config);
    return response.data;
  } catch (error) {
    console.error("API error:", error.message);
    return [];
  }
};

// 3. Chunked calls and data mapping
const makeApiRequestsInChunks = async (skuPairs, chunkSize) => {
  const allResults = [];
  for (let i = 0; i < skuPairs.length; i += chunkSize) {
    const chunk = skuPairs.slice(i, i + chunkSize);
    const theirSkus = chunk.map((entry) => entry.theirSku);
    const apiData = await fetchTireDiscounterData(theirSkus);

    for (const item of apiData) {
      const match = chunk.find((e) => e.theirSku === item.itemNumber);
      if (!match) continue;

      const totalQty = item.locations.reduce((sum, loc) => sum + loc.qtyAvailable, 0);

      allResults.push({
        ourSku: match.ourSku,
        theirSku: item.itemNumber,
        price: item.pricing.price,
        msrp: item.pricing.msrp,
        map: item.pricing.map,
        inventory: totalQty,
      });
    }
  }

  return allResults;
};

// 4. Run and export data
getTireDiscounterSkus()
  .then((skuPairs) => makeApiRequestsInChunks(skuPairs, 20))
.then((results) => {
  console.log("Total results:", results.length);
  console.dir(results, { depth: null });
})
  .catch((err) => {
    console.error(err);
  });

module.exports = {
  getTireDiscounterSkus,
  fetchTireDiscounterData,
  makeApiRequestsInChunks,
};
