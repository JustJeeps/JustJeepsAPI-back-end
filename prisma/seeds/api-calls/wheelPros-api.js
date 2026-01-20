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





// const { PrismaClient } = require("@prisma/client");
// const axios = require("axios");

// // Create an instance of PrismaClient
// const prisma = new PrismaClient();

// // const getWheelProsSkus = async () => {
// //   const skus = await prisma.product.findMany({
// //     where: {
// //       searchableSku: {
// //         not: "",
// //         // endsWith: "-"
// //       },
// //       brand_name: {
// //         in: ["American Racing", "Black Rhino", "Fuel Off-Road", "KMC Wheels", "ReadyLIFT", "Morimoto", "TeraFlex","Gorilla Automotive","G2 Axle & Gear","Pois /on Spyder Customs","PRO COMP Alloy Wheels","PRO COMP Steel Wheels","PRO COMP Suspension","Pro Comp Tires","Rubicon Express","Smittybilt"]
// //         // in:["TeraFlex"]   
// //         // in: ["American Racing"]
// //       },
// //       status: 1
// //     },
// //     select: {
// //       sku: true
// //     }
// //   });
// //   console.log(`Total number of products with a Wheel Pros Sku: ${skus.length}`);
// //   const results = skus.map((product) => product.sku.split('-').slice(1).join('-'));
// //   console.log(`results ${results}`);
// //   return results;
// // };

// const getWheelProsSkus = async () => {
//   const skus = await prisma.product.findMany({
//     where: {
//       searchableSku: {
//         not: "",
//       },
//       brand_name: {
//         in: [
//           "American Racing", "Black Rhino", "Fuel Off-Road", "KMC Wheels", "ReadyLIFT", "Morimoto", "TeraFlex",
//           "Gorilla Automotive", "G2 Axle & Gear", "Pois /on Spyder Customs", "PRO COMP Alloy Wheels",
//           "PRO COMP Steel Wheels", "PRO COMP Suspension", "Pro Comp Tires", "Rubicon Express", "Smittybilt","Nitto Tire"
//         ]
//         // in: [
//         //   "Nitto Tire",
//         // ]
//       },
//       status: 1
//     },
//     select: {
//       sku: true,
//       brand_name: true
//     }
//   });

//   console.log(`Total number of products with a Wheel Pros Sku: ${skus.length}`);

//   const results = skus.map((product) => {
//     const rawSku = product.sku.split('-').slice(1).join('-');
    
//     if (product.brand_name === "TeraFlex") {
//       return rawSku.padStart(18, '0');
//     }
    
//     if (product.brand_name === "Smittybilt") {
//       return `SB${rawSku}`;
//     }

//     if (product.brand_name === "PRO COMP Alloy Wheels") {
//       return `PXA${rawSku}`;
//     }

//     if (product.brand_name === "PRO COMP Suspension") {
//       return `EXP${rawSku}`;
//     }
//       if (product.brand_name === "Nitto Tire") {
//     const formatted = rawSku.length === 6
//       ? `${rawSku.slice(0, 3)}-${rawSku.slice(3)}`
//       : rawSku; // fallback if not 6 digits
//     return `N${formatted}`;
//   }
  
//     return rawSku;
//   });

//   console.log(`results ${results}`);
//   return results;
// };



// const wheelProsApi = async (skus) => {
//   const data = {
//     filters: {
//       sku: skus,
//       company: "4000",
//       currency: "CAD",
//       customer: "1081993"
//       // "effectiveDate": "2021-12-21"
//     },
//     limit: 10,
//     priceType: [
//       "msrp",
//       "map",
//       "nip"
//     ]
//   };

//   const config = {
//     method: 'post',
//     maxBodyLength: Infinity,
//     url: 'https://api.wheelpros.com/pricings/v1/search',
//     headers: {
//       'Authorization': 'Bearer eyJraWQiOiJTekpBRlFHbnY3QWQzS3BBOEJnc2RJa2tONzJrTnNyZ2lMUUF0TFwvb09oST0iLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjNzJiM2EwNC1mYzkwLTRlZWQtYjY4Ny1jYzVhNzNmMjRhNjQiLCJjb2duaXRvOmdyb3VwcyI6WyJ3cC1hcGktY29yZS1yZXBvcnRzIiwid3AtYXBpLWNvcmUtcHJpY2luZyIsIm5vbkFkbWluVXNlciIsIndwLWFwaS1jb3JlLXdhcmVob3VzZSIsIndwLWFwaS1jb3JlLXByb2R1Y3QiLCJ3cC1hcGktY29yZS1vcmRlcnMiXSwiaXNzIjoiaHR0cHM6XC9cL2NvZ25pdG8taWRwLnVzLXdlc3QtMi5hbWF6b25hd3MuY29tXC91cy13ZXN0LTJfZ1ZsakJaNWRiIiwiY2xpZW50X2lkIjoiNGxxOWgzaThhNnRoZG5paG9razU2OTJiYjMiLCJldmVudF9pZCI6ImMwYzZjNjg0LWY1MGYtNDFmZC1iMjU4LTNmNjAwODRjNWYxYiIsInRva2VuX3VzZSI6ImFjY2VzcyIsInNjb3BlIjoiYXdzLmNvZ25pdG8uc2lnbmluLnVzZXIuYWRtaW4iLCJhdXRoX3RpbWUiOjE3NTM3OTU2NTcsImV4cCI6MTc1Mzc5OTI1NywiaWF0IjoxNzUzNzk1NjU3LCJqdGkiOiI5ZmNkZGY2YS0zMjJjLTRjOWUtOWUyMy01N2IyNmJjNGExOGUiLCJ1c2VybmFtZSI6ImprZW1wZXJAanVzdGplZXBzLmNvbSJ9.kSM9MpE2pHDoyzMr9uQReZg_xeqK48kNFyvRx4A24BYcaFHOlK4hIY7dIBhi1iWAGzGsM5mvVyXMj85EtwRxJMIXWtPmxB3yQmxNFQAtWuEQzswo_P-WPnQtbSi30yBxjJkFo8jvrCgLs7Gy0RnZts78NaWUm4smYjxzXSx_YDKGQC_JrQIAsrrGQA-3qhsWJIvc21AZEnnko90BpZ7GQAQTujLM3YhLb4ANn8AFXjUIkxjsPSYZxiXOr36a1zmQfX9PuFN4IVk6A-L86A48uzb3K4r1aZhKgyc_Dmt8nbrVQIeF3Gz3o5VB2A5mWrfMpehI6kMJOOijsJXKqvKmVQ',
//       'Content-Type': 'application/json'
//     },
//     data: JSON.stringify(data)
//   };

//   try {
//     const response = await axios(config);
//     // console.log(response.data);
//     return response.data;
//   } catch (error) {
//     console.log(error);
//   }
// };

//  const makeApiRequestsInChunks = async (skus, chunkSize) => {
//   const chunks = Math.ceil(skus.length / chunkSize);
//   console.log(`Total number of chunks: ${chunks}`);
//   const allResults = []; // Create an array to store all the results
//   for (let i = 0; i < chunks; i++) {
//     const start = i * chunkSize;
//     const end = (i + 1) * chunkSize;
//     const chunk = skus.slice(start, end);
//     const result = await wheelProsApi(chunk);
//     allResults.push(...result); // Spread the result array into the allResults array
//   }
//   return allResults; // Return the array containing all the results
// };

// // Call the function and handle the returned object
//  getWheelProsSkus()
//   .then((skus) => {
//     return makeApiRequestsInChunks(skus, 50); // Return the result from makeApiRequestsInChunks
//   })
//   .then((allResults) => {
//     console.log('All results:', allResults); // Output the concatenated results as an array of objects
//   })
//   .catch((error) => {
//     console.log(error);
//   });

//   module.exports = { getWheelProsSkus, wheelProsApi, makeApiRequestsInChunks };


  