const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
require("dotenv").config();

const prisma = new PrismaClient();

// ✅ 1. Fetch WheelPros Auth Token
const getAuthToken = async () => {
  try {
    console.log("🔍 USER:", process.env.WHEELPROS_USER);
    console.log("🔍 PASS:", process.env.WHEELPROS_PASS ? "****" : "NOT SET");

    const response = await axios.post(
      "https://api.wheelpros.com/auth/v1/authorize",
      {
        userName: process.env.WHEELPROS_USER,
        password: process.env.WHEELPROS_PASS,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    console.log("🔍 AUTH RESPONSE:", response.data);

    const token = response.data?.accessToken;
    if (!token) throw new Error("❌ No accessToken found in API response");

    console.log("✅ Token retrieved successfully");
    return token;
  } catch (err) {
    console.error("❌ Failed to fetch WheelPros token:", err.response?.data || err.message);
    throw err;
  }
};

// ✅ 2. Fetch SKUs from DB and format them
const getWheelProsSkus = async () => {
  const brands = [
    "American Racing", "Black Rhino", "Fuel Off-Road", "KMC Wheels",
    "ReadyLIFT", "Morimoto", "TeraFlex", "Gorilla Automotive",
    "G2 Axle & Gear", "Poison Spyder Customs", "PRO COMP Alloy Wheels",
    "PRO COMP Steel Wheels", "PRO COMP Suspension", "Pro Comp Tires",
    "Rubicon Express", "Smittybilt", "Nitto Tire"
  ];

  const products = await prisma.product.findMany({
    where: { searchableSku: { not: "" }, brand_name: { in: brands }, status: 1 },
    select: { sku: true, brand_name: true }
  });

  console.log(`✅ Found ${products.length} WheelPros products`);

  return products.map(({ sku, brand_name }) => {
    const rawSku = sku.split("-").slice(1).join("-");

    switch (brand_name) {
      case "TeraFlex": return rawSku.padStart(18, "0");
      case "Smittybilt": return `SB${rawSku}`;
      case "PRO COMP Alloy Wheels": return `PXA${rawSku}`;
      case "PRO COMP Suspension": return `EXP${rawSku}`;
      case "Nitto Tire":
        return rawSku.length === 6 ? `N${rawSku.slice(0, 3)}-${rawSku.slice(3)}` : `N${rawSku}`;
      default: return rawSku;
    }
  });
};

// ✅ 3. Call WheelPros API with dynamic token
const wheelProsApi = async (token, skus) => {
  const data = {
    filters: { sku: skus, company: "4000", currency: "CAD", customer: "1081993" },
    limit: 10,
    priceType: ["msrp", "map", "nip"]
  };

  try {
    const response = await axios.post(
      "https://api.wheelpros.com/pricings/v1/search",
      data,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        maxBodyLength: Infinity
      }
    );
    return response.data;
  } catch (err) {
    console.error("❌ API Request Failed:", err.response?.data || err.message);
    return [];
  }
};

// ✅ 4. Make Requests in Chunks
const makeApiRequestsInChunks = async (token, skus, chunkSize = 50) => {
  if (!Array.isArray(skus) || skus.length === 0) {
    console.error("❌ No SKUs provided to chunk");
    return [];
  }

  const chunks = Math.ceil(skus.length / chunkSize);
  console.log(`🔹 Splitting into ${chunks} chunks`);
  const allResults = [];

  for (let i = 0; i < chunks; i++) {
    const chunk = skus.slice(i * chunkSize, (i + 1) * chunkSize);
    console.log(`➡️ Requesting chunk ${i + 1}/${chunks} (${chunk.length} SKUs)`);
    const result = await wheelProsApi(token, chunk);
    if (Array.isArray(result)) allResults.push(...result);
  }

  return allResults;
};

module.exports = { getAuthToken, getWheelProsSkus, wheelProsApi, makeApiRequestsInChunks };
