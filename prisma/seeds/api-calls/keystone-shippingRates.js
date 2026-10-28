const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");
const { Parser } = require("json2csv");

const prisma = new PrismaClient();

// Keystone API Credentials
const KEYSTONE_API_KEY = process.env.KEYSTONE_KEY_DS;
const KEYSTONE_ACCOUNT_NO = process.env.KEYSTONE_ACCOUNT_DS;
const KEYSTONE_API_URL = "http://order.ekeystone.com/wselectronicorder/electronicorder.asmx";

// Test addresses across Canada
const addresses = [
  { city: "TORONTO", zip: "M8V1X9" },
  { city: "VANCOUVER", zip: "V5N1X6" },
  { city: "GATINEAU", zip: "J8Y1X9" },
  { city: "CALGARY", zip: "T2Y2W3" },
];

const BATCH_SIZE = 30;  // Number of SKUs processed per batch
const DELAY_BETWEEN_BATCHES = 100000; // 60 seconds (1 min) delay

// Function to introduce a delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getKeystoneShippingRates = async () => {
  try {
    console.log("🚀 Starting Keystone Shipping Rate API call...");

    // Fetch SKUs with Keystone code
    const skus = await prisma.product.findMany({
      where: {
        keystone_code: { not: "" },
        brand_name: { in: [

          "Rancho",
        "Thule Racks",
        "King Off Road",
        "Fairchild Industries",
        "Banks Power",
        "Synergy MFG",
        "Baer",
        "Old Man Emu",
        "G2 Axle & Gear",
        "Oracle Lighting",
        "Energy Suspension",
        "Quake LED",
        "Hi-Lift Jack",
        "GT Styling",
        "Firestone Airide",
        "aFe Power",
        "RockJock",
        "Rolling Big Power",
        "Falken WildPeak",
        "Classic Tube",
        "Lynx",
        "Rubicon Express",
        "Husky Liners",
        "Mamba Offroad",
        "RCV Performance",
        "Roam Adventure Co.",
        "Magnum by Raptor Series",
        "Centerforce",
        "ReadyLIFT",
        "Superwinch",
        "Surco",
        "Blue Ox",
        "Diode Dynamics",
        "Maxxis",
        "Rival 4x4",
        "Overtread",
        "Wilco Offroad",
        "Havoc Offroad",
        "DynoMax Exhaust",
        "Curt Manufacturing",
        "Meyer Products",
        "Putco",
        "AEM",
        "AccuPart",
        "Napier Sportz",
        "RT Off-Road",
        "DeeZee",
        "SeaSucker",
        "RES-Q",
        "Fifteen52",
        "PPR Industries",
        "BDS Suspension",
        "J.W. Speaker",
        "Poison Spyder Customs",
        "Morimoto",
        "Lange Originals",
        "Rightline Gear",
        "Nacho Offroad Lighting",
        "Artec Industries",
        "Advance Accessory Concepts",
        "Cliffride",
        "Tom Woods",
        "Addco",
        "Rock Krawler Suspension",
        "Electric Life",
        "HELLA",
        "MORryde",
        "Roll-N-Lock by RealTruck",
        "Rugged Radios",
        "American Racing",
        "XK Glow",
        "Ten Factory",
        "Extang",
        "Accuair",
        "Ripp Supercharger",
        "Air Design",
        "Truxedo",
        "ODYSSEY Battery",
        "mPower",
        "Kleinn",
        "Stinger Off-Road",
        "Zone Offroad",
        "PRO COMP Suspension",
        "Faulkner",
        "Pro Eagle",
        "Pro Series",
        "AirBedz",
        "Lost Canyon",
        "Thret Offroad",
        "JKS Manufacturing",
        "Bilstein",
        "K&N",
        "Plasticolor",
        "Dynatrac",
        "Tuff Stuff 4x4",
        "T-Rex",
        "CargoGlide",
        "Cervini's Auto Design",
        "SpeedFX",
        "Firestone",
        "Yokohama",
        "Mayhem Wheels",
        "Sailun Tires",
        "A.R.E.",
        "AO Coolers",
        "EATON",
        "CARR",
        "LUK Clutches",
        "Alpine",
        "Daystar",
        "Auto Meter",
        "Draw-Tite",
        "Mountain Offroad",
        "ANZO USA",
        "Advance Adapters",
        "Decked",
        "Trail Master",
        "Husky Towing Products",
        "DU-HA",
        "Garage Smart",
        "CAT",
        "Dometic",
        "Free Spirit Recreation",
        "YKW",
        "Bridgestone",
        "Enthuze Truck Accessories",
        "Catamount",
        "Stromberg Carlson Products",
        "Hellwig Suspension",
        "Super Swamper",
        "Cold Case",
        "Goodyear",
        "Michelin",
        "Nokian Tyres",
        "Thor's Lightning Air Systems",
        "Cobra Electronics",
        "Pacer Performance Products",
        "Vertically Driven Products",
        "Z Automotive",
        "SpiderWebShade",
        "Bolt Lock",
        "OFFGRID",
        "Factor 55",
        "Borgeson",
        "Power Trax",
        "Dirty Dog 4X4",
        "EBC Brakes",
        "AIRAID",
        "JBA Performance Exhaust",
        "Gibson Performance",
        "Hypertech",
        "D&C Designs",
        "Automotive Gold",
        "Spyder Automotive",
        "McGard Wheel Locks",
        "RotoPax",
        "Hopkins",
        "Gorilla Automotive",
        "Eibach Springs",
        "Brand Motion",
        "Diver Down",
        "Trimax",
        "TecStyle",
        "Up Down Air",
        "MOOG",
        "Grant Products",
        "In Pro Carwear",
        "AMI Styling",
        "Pavement Ends",
        "Recon",
        "MCE",
        "RockNob",
        "Under The Sun",
        "PIAA",
        "4WP",
        "Viair",
        "Tyger Auto",
        "BBK Performance",
        "Rockagator",
        "Jeep",
        "Krystal Kleer",
        "Tekonsha",
        "Seatbelt Solutions",
        "American Trail Products",
        "Jet Performance",
        "SpiderTrax",
        "Crown Performance",
        "AJT Design",
        "POR-15",
        "Element - Fire Extinguishers",
        "XENON",
        "Overland Outfitters",
        "MAXTRAX",
        "TuxMat",
        "NOCO",
        "MONROE Shocks & Struts",
        "Paramount Automotive",
        "Lube Locker",
        "Switch-Pros",
        "Superchips",
        "S&B Filters",
        "Jeep Tweaks",
        "Garvin Wilderness",
        "Just Jeeps",
        "Bully Truck",
        "ANCO",
        "Iron Cross",
        "Trigger",
        "HyLine OffRoad",
        "Heininger Automotive",
        "Jammock",
        "Kicker Jeep Audio & Electronics",
        "Mirage Unlimited",
        "Rox Offroad",
        "WestCoast Wheel Accessories",
        "ProMaxx Automotive",
        "Pro Comp Tires",
        "XG Cargo",
        "Valeo",
        "Dorman",
        "Camco",
        "Savvy Off Road",
        "Holley",
        "Pedal Commander",
        "Misch 4x4",
        "Outback Adventures",
        "American Outlaw",
        "Full Auto",
        "Briidea",
        "Autowatch Canada - DO NOT NEED TO UPDATE",
        "Scosche",
        "Griffin Radiator",
        "Timbren",
        "Schumacher",
        "Novak Conversions",
        "Phoenix Graphix",
        "ExoShield ULTRA",
        "Focus Auto Design",
        "Chemical Guys",
        "Sylvania",
        "INSYNC",
        "RainX",
        "Coyote Wheel",
        "Performance Distributors",
        "Prothane Motion Control",
        "Covercraft",
        "Vision X",
        "NGK",
        "Let's Go Aero",
        "Harken Hoister",
        "Precision Replacement Parts",
        "Safety Seal",
        "Gate King",
        "Max-Bilt"
        ] },
        status: 1,
      },
      select: { keystone_code: true, brand_name: true },
    });

    if (skus.length === 0) {
      console.log("❌ No SKUs found with status 1.");
      return;
    }

    console.log(`📦 Total SKUs to process: ${skus.length}`);

    const allResponses = {};
    console.time("Execution Time");

    for (const address of addresses) {
      allResponses[address.city] = [];

      // Process in batches
      for (let i = 0; i < skus.length; i += BATCH_SIZE) {
        const batch = skus.slice(i, i + BATCH_SIZE);
        console.log(`🚀 Processing batch ${i / BATCH_SIZE + 1}/${Math.ceil(skus.length / BATCH_SIZE)} for ${address.city}`);

        const responses = await Promise.allSettled(
          batch.map(sku => makeRequests(sku, address))
        );

        responses.forEach(res => {
          if (res.status === "fulfilled") {
            allResponses[address.city].push(res.value);
          } else {
            console.error(`❌ Error fetching SKU: ${res.reason}`);
          }
        });

        console.log(`⏳ Waiting ${DELAY_BETWEEN_BATCHES / 1000} seconds before next batch...`);
        await delay(DELAY_BETWEEN_BATCHES);
      }
    }

    console.timeEnd("Execution Time");

    console.log("✅ Final Shipping Rates:", JSON.stringify(allResponses, null, 2));

    // Save data to CSV
    await saveToCSV(allResponses);

    return allResponses;
  } catch (error) {
    console.error("❌ Error fetching shipping rates:", error);
  }
};

// Function to make API requests for each SKU
const makeRequests = async ({ keystone_code, brand_name }, address) => {
  console.log(`📡 Requesting shipping rates for ${brand_name} - SKU: ${keystone_code} to ${address.city}`);

  try {
    const xmlRequest = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
          xmlns:ekey="http://eKeystone.com">
        <soapenv:Header/>
        <soapenv:Body>
          <ekey:GetShippingOptions>
            <ekey:Key>${KEYSTONE_API_KEY}</ekey:Key>
            <ekey:FullAccountNo>${KEYSTONE_ACCOUNT_NO}</ekey:FullAccountNo>
            <ekey:FullPartNo>${keystone_code}</ekey:FullPartNo>
            <ekey:ToZip>${address.zip}</ekey:ToZip>
          </ekey:GetShippingOptions>
        </soapenv:Body>
      </soapenv:Envelope>`;

    const config = {
      method: "post",
      url: KEYSTONE_API_URL,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": '"http://eKeystone.com/GetShippingOptions"',
      },
      data: xmlRequest,
    };

    const response = await axios.request(config);
    const parser = new XMLParser({ ignoreAttributes: false });
    const jsonResponse = parser.parse(response.data);

    let rates =
      jsonResponse["soap:Envelope"]["soap:Body"]["GetShippingOptionsResponse"]["GetShippingOptionsResult"]["diffgr:diffgram"]["ShippingOptions"]["Rates"];

    if (!rates) {
      return { brand_name, sku: keystone_code, destination: address.city, shipping_options: "N/A", cheapest_shipping: "N/A" };
    }

    if (!Array.isArray(rates)) {
      rates = [rates]; 
    }

    const shippingOptions = rates.map((option) => ({
      service: option.Name,
      cost: parseFloat(option.Rate),
    }));

    const validOptions = shippingOptions.filter((opt) => opt.service !== "Keystone Truck" && opt.cost > 0);
    const cheapestValidOption = validOptions.length ? validOptions.reduce((min, option) => (option.cost < min.cost ? option : min)) : null;

    return {
      brand_name,
      sku: keystone_code,
      destination: address.city,
      shipping_options: shippingOptions,
      cheapest_shipping: cheapestValidOption ? `${cheapestValidOption.service} - $${cheapestValidOption.cost.toFixed(2)}` : "N/A",
    };
  } catch (error) {
    console.error(`❌ Error for ${brand_name} - SKU: ${keystone_code} to ${address.city}:`, error.message);
    return { brand_name, sku: keystone_code, destination: address.city, shipping_options: "Error", cheapest_shipping: "Error" };
  }
};

// Function to save data to CSV
const saveToCSV = async (allResponses) => {
  const filePath = "/Users/tessfbs/justJeepsAPI/JustJeepsAPI-back-end/prisma/seeds/api-calls/api-csv-responses/shipping_rates_keystone.csv";
  let csvData = [];

  let allKeystoneCodes = new Set();
  Object.values(allResponses).forEach((cityData) => {
    cityData.forEach((entry) => {
      if (entry.sku) {
        allKeystoneCodes.add(entry.sku.trim());
      }
    });
  });

  allKeystoneCodes = Array.from(allKeystoneCodes);
  const productDetails = await prisma.product.findMany({
    where: { keystone_code: { in: allKeystoneCodes } },
    select: { sku: true, brand_name: true, keystone_code: true, shippingFreight: true, price: true },
  });

  const productMap = new Map();
  productDetails.forEach((product) => {
    productMap.set(product.keystone_code.trim(), {
      sku: product.sku || "N/A",
      brand_name: product.brand_name || "Unknown",
      shippingFreight: product.shippingFreight || "N/A",
      price: product.price !== null ? product.price.toFixed(2) : "N/A",
    });
  });

  allKeystoneCodes.forEach((keystone_code) => {
    const product = productMap.get(keystone_code.trim()) || { sku: "N/A", brand_name: "Unknown", shippingFreight: "N/A", price: "N/A" };

    const entry = {
      Meyer_Code: keystone_code,
      SKU: product.sku,
      Brand: product.brand_name,
      Shipping_Freight: product.shippingFreight,
      Vancouver: getShippingRate(allResponses, "VANCOUVER", keystone_code),
      Ontario: getShippingRate(allResponses, "TORONTO", keystone_code),
      Quebec: getShippingRate(allResponses, "GATINEAU", keystone_code),
      Alberta: getShippingRate(allResponses, "CALGARY", keystone_code),
      Price: product.price,
    };

    csvData.push(entry);
  });

  const json2csvParser = new Parser();
  fs.writeFileSync(filePath, json2csvParser.parse(csvData));

  console.log(`✅ CSV file saved at: ${filePath}`);
};

// Helper function to get the cheapest rate per city
const getShippingRate = (allResponses, city, keystone_code) => {
  if (!allResponses[city]) {
    return "N/A";
  }

  const entry = allResponses[city].find(item => item.sku.trim() === keystone_code.trim());
  return entry && entry.cheapest_shipping !== "N/A" && entry.cheapest_shipping !== "Error"
    ? entry.cheapest_shipping.split("$")[1] // Extract only the cost
    : "N/A";
};


// Execute
getKeystoneShippingRates();



//*******




// const { PrismaClient } = require("@prisma/client");
// const axios = require("axios");
// const fs = require("fs");
// const path = require("path");
// const { XMLParser } = require("fast-xml-parser");
// const { Parser } = require("json2csv");

// const prisma = new PrismaClient();

// // Keystone API Credentials
// const KEYSTONE_API_KEY = process.env.KEYSTONE_KEY_DS;
// const KEYSTONE_ACCOUNT_NO = process.env.KEYSTONE_ACCOUNT_DS;
// const KEYSTONE_API_URL = "http://order.ekeystone.com/wselectronicorder/electronicorder.asmx";

// // Test addresses across Canada
// const addresses = [
//   { city: "TORONTO", zip: "M8V1X9" },
//   { city: "VANCOUVER", zip: "V5N1X6" },
//   { city: "GATINEAU", zip: "J8Y1X9" },
//   { city: "CALGARY", zip: "T2Y2W3" }
// ];

// const getKeystoneShippingRates = async () => {
//   try {
//     console.log("🚀 Starting Keystone Shipping Rate API call...");

//     const skus = await prisma.product.findMany({
//       where: {
//         keystone_code: { not: "" },
//         // brand_name: { in: ["K&N"] },clea
//         status: 1,
//       },
//       select: { keystone_code: true, brand_name: true },
//     });

//     if (skus.length === 0) {
//       console.log("❌ No SKUs found with status 1.");
//       return;
//     }

//     console.log(`📦 Total SKUs to process: ${skus.length}`);

//     const allResponses = {};

//     console.time("Execution Time");

//     for (const address of addresses) {
//       allResponses[address.city] = [];

//       for (const sku of skus) {
//         const response = await makeRequests(sku, address);
//         allResponses[address.city].push(response);
//       }
//     }

//     console.timeEnd("Execution Time");

//     console.log("✅ Final Shipping Rates for All Addresses:", JSON.stringify(allResponses, null, 2));

//     // Generate CSV and Save to File
//     await saveToCSV(allResponses);

//     return allResponses;
//   } catch (error) {
//     console.error("❌ Error fetching shipping rates:", error);
//   }
// };

// const makeRequests = async ({ keystone_code, brand_name }, address) => {
//   console.log(`📡 Requesting shipping rates for ${brand_name} - SKU: ${keystone_code} to ${address.city}`);

//   try {
//     const xmlRequest = `
//       <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
//           xmlns:ekey="http://eKeystone.com">
//         <soapenv:Header/>
//         <soapenv:Body>
//           <ekey:GetShippingOptions>
//             <ekey:Key>${KEYSTONE_API_KEY}</ekey:Key>
//             <ekey:FullAccountNo>${KEYSTONE_ACCOUNT_NO}</ekey:FullAccountNo>
//             <ekey:FullPartNo>${keystone_code}</ekey:FullPartNo>
//             <ekey:ToZip>${address.zip}</ekey:ToZip>
//           </ekey:GetShippingOptions>
//         </soapenv:Body>
//       </soapenv:Envelope>`;

//     const config = {
//       method: "post",
//       url: KEYSTONE_API_URL,
//       headers: {
//         "Content-Type": "text/xml; charset=utf-8",
//         "SOAPAction": '"http://eKeystone.com/GetShippingOptions"',
//       },
//       data: xmlRequest,
//     };

//     const response = await axios.request(config);
//     const parser = new XMLParser({ ignoreAttributes: false });
//     const jsonResponse = parser.parse(response.data);

//     const rates = jsonResponse["soap:Envelope"]["soap:Body"]["GetShippingOptionsResponse"]["GetShippingOptionsResult"]["diffgr:diffgram"]["ShippingOptions"]["Rates"];

//     if (!rates || rates.length === 0) {
//       console.log(`❌ No shipping options for ${brand_name} - SKU: ${keystone_code} to ${address.city}`);
//       return { brand_name, sku: keystone_code, destination: address.city, shipping_options: "N/A", cheapest_shipping: "N/A" };
//     }

//     // Extract all shipping options
//     const shippingOptions = rates.map((option) => ({
//       service: option.Name,
//       cost: parseFloat(option.Rate),
//     }));

//     console.log(`✅ Shipping options for ${brand_name} - SKU: ${keystone_code} to ${address.city}:`, shippingOptions);

//     // Filter out "Keystone Truck" and find the cheapest valid option
//     const validOptions = shippingOptions.filter(opt => opt.service !== "Keystone Truck" && opt.cost > 0);
//     const cheapestValidOption = validOptions.length > 0 ? validOptions.reduce((min, option) => option.cost < min.cost ? option : min) : null;

//     return {
//       brand_name,
//       sku: keystone_code,
//       destination: address.city,
//       shipping_options: shippingOptions,
//       cheapest_shipping: cheapestValidOption ? `${cheapestValidOption.service} - $${cheapestValidOption.cost.toFixed(2)}` : "N/A"
//     };
//   } catch (error) {
//     console.error(`❌ Error for ${brand_name} - SKU: ${keystone_code} to ${address.city}:`, error.message);
//     return { brand_name, sku: keystone_code, destination: address.city, shipping_options: "Error", cheapest_shipping: "Error" };
//   }
// };

// const saveToCSV = async (allResponses) => {
//   const filePath = "/Users/tessfbs/justJeepsAPI/JustJeepsAPI-back-end/prisma/seeds/api-calls/api-csv-responses/shipping_rates_keystone.csv";

//   let csvData = [];

//   // Get all unique Keystone codes from API response
//   let allKeystoneCodes = new Set();
//   Object.values(allResponses).forEach((cityData) => {
//     cityData.forEach((entry) => {
//       if (entry.sku) { // `sku` in API response is actually `keystone_code`
//         allKeystoneCodes.add(entry.sku.trim());
//       }
//     });
//   });

//   allKeystoneCodes = Array.from(allKeystoneCodes);

//   // Fetch SKU, shippingFreight, brand, and price from Prisma Product table based on Keystone Code
//   const productDetails = await prisma.product.findMany({
//     where: { keystone_code: { in: allKeystoneCodes } },
//     select: { sku: true, brand_name: true, keystone_code: true, shippingFreight: true, price: true },
//   });

//   // Convert product details into a lookup map
//   const productMap = new Map();
//   productDetails.forEach((product) => {
//     productMap.set(product.keystone_code.trim(), {
//       sku: product.sku || "N/A",
//       brand_name: product.brand_name || "Unknown",
//       shippingFreight: product.shippingFreight || "N/A",
//       price: product.price !== null ? product.price.toFixed(2) : "N/A",
//     });
//   });

//   // Build CSV rows for each Keystone Code
//   allKeystoneCodes.forEach((keystone_code) => {
//     const product = productMap.get(keystone_code.trim()) || { 
//       sku: "N/A", 
//       brand_name: "Unknown", 
//       shippingFreight: "N/A",
//       price: "N/A",
//     };

//     const entry = {
//       Meyer_Code: keystone_code,  // Meyer_Code in Meyer CSV, but Keystone_Code for this
//       SKU: product.sku,
//       Brand: product.brand_name,
//       Shipping_Freight: product.shippingFreight,
//       Vancouver: getShippingRate(allResponses, "VANCOUVER", keystone_code),
//       Ontario: getShippingRate(allResponses, "TORONTO", keystone_code),
//       Quebec: getShippingRate(allResponses, "GATINEAU", keystone_code),
//       Alberta: getShippingRate(allResponses, "CALGARY", keystone_code),
//       Price: product.price,
//     };

//     csvData.push(entry);
//   });

//   // Convert JSON to CSV
//   const json2csvParser = new Parser({ fields: ["Meyer_Code", "SKU", "Brand", "Shipping_Freight", "Vancouver", "Ontario", "Quebec", "Alberta", "Price"] });
//   const csv = json2csvParser.parse(csvData);

//   fs.writeFileSync(filePath, csv);

//   console.log(`✅ CSV file saved at: ${filePath}`);
// };

// // Helper function to get the cheapest rate per city
// const getShippingRate = (allResponses, city, keystone_code) => {
//   if (!allResponses[city]) {
//     return "N/A";
//   }

//   const entry = allResponses[city].find(item => item.sku.trim() === keystone_code.trim());
//   return entry && entry.cheapest_shipping !== "N/A" && entry.cheapest_shipping !== "Error"
//     ? entry.cheapest_shipping.split("$")[1] // Extract only the cost
//     : "N/A";
// };

// // Execute
// getKeystoneShippingRates();
