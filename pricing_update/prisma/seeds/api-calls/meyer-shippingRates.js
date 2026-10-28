const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Parser } = require("json2csv");

const prisma = new PrismaClient();

const addresses = [
  { address: "55 Elma Street", city: "TORONTO", state: "ON", zip: "M8V 1X9", country: "Canada" },
  { address: "1541 e 10 ave", city: "VANCOUVER", state: "BC", zip: "V5N 1X6", country: "Canada" },
  { address: "150 rue Bourque", city: "GATINEAU", state: "QC", zip: "J8Y 1X9", country: "Canada" },
  { address: "207 NW Shawinigan Way SW", city: "CALGARY", state: "QC", zip: "T2Y 2W3", country: "Canada" },
];

const getMeyerShippingRates = async () => {
  try {
    console.log("Starting Meyer Shipping Rate API call...");

    // Fetch all SKUs where status is 1, and meyer_code is not empty
    const skus = await prisma.product.findMany({
      where: {
        meyer_code: { not: "" },
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
        //only the first 2 skus
        status: 1,
      },
      select: { meyer_code: true, brand_name: true },
    }); 

    if (skus.length === 0) {
      console.log("No SKUs found with status 1.");
      return;
    }

    console.log(`Total SKUs to process: ${skus.length}`);

    const chunkedSkus = [];
    for (let i = 0; i < skus.length; i += 100) {
      chunkedSkus.push(skus.slice(i, i + 100));
    }

    const allResponses = {};

    console.time("Execution Time");

    for (const address of addresses) {
      allResponses[address.city] = [];

      for (let i = 0; i < chunkedSkus.length; i++) {
        const chunk = chunkedSkus[i];
        const chunkIndex = i + 1;
        const responses = await makeRequests(chunk, chunkIndex, address);
        allResponses[address.city].push(...responses);
      }
    }

    console.timeEnd("Execution Time");

    console.log("✅ Final Shipping Rates for All Addresses:", JSON.stringify(allResponses, null, 2));

    // Generate CSV and Save to File
    await saveToCSV(allResponses);

    return allResponses;
  } catch (error) {
    console.error("❌ Error fetching shipping rates:", error);
  }
};

const makeRequests = async (chunk, chunkIndex, address) => {
  console.log(`Processing chunk ${chunkIndex} (${chunk.length} SKUs) for ${address.city}...`);
  const responses = [];

  for (let i = 0; i < chunk.length; i++) {
    const { meyer_code, brand_name } = chunk[i];

    console.log(`Requesting shipping rate for ${brand_name} - SKU: ${meyer_code} to ${address.city}`);

    try {
      const url = `https://meyerapi.meyerdistributing.com/http/default/ProdAPI/v2/ShippingRateQuote?ItemNumber=${meyer_code}&ShipToAddress1=${encodeURIComponent(address.address)}&ShipToCity=${encodeURIComponent(address.city)}&Quantity=1&ShipToZipcode=${encodeURIComponent(address.zip)}&ShipToCountry=${encodeURIComponent(address.country)}&ShipToState=${encodeURIComponent(address.state)}`;

      const config = {
        method: "get",
        url,
        headers: {
          Authorization: `Espresso ${process.env.MEYER_KEY}`,
          "Content-Type": "application/json",
        },
      };

      const response = await axios.request(config);
      const shippingOptions = response.data;

      if (Array.isArray(shippingOptions) && shippingOptions.length > 0) {
        const cheapestShipping = shippingOptions.reduce((min, option) =>
          option.Cost < min.Cost ? option : min
        );

        console.log(
          `✅ Cheapest for ${brand_name} - SKU: ${meyer_code} to ${address.city}:`,
          cheapestShipping.Cost
        );

        responses.push({
          brand_name,
          sku: meyer_code,
          destination: address.city,
          cheapest_shipping: cheapestShipping.Cost,
        });
      } else {
        console.log(`❌ No shipping options for ${brand_name} - SKU: ${meyer_code} to ${address.city}`);
        responses.push({
          brand_name,
          sku: meyer_code,
          destination: address.city,
          cheapest_shipping: "N/A"
        });
      }
    } catch (error) {
      console.error(`❌ Error for ${brand_name} - SKU: ${meyer_code} to ${address.city}:`, error.message);
      responses.push({
        brand_name,
        sku: meyer_code,
        destination: address.city,
        cheapest_shipping: "Error"
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 90)); // Avoid rate limits
  }

  console.log(`Chunk ${chunkIndex} for ${address.city} completed.`);
  await new Promise((resolve) => setTimeout(resolve, 150)); // Delay between chunks

  return responses;
};

const saveToCSV = async (allResponses) => {
  const filePath = "/Users/tessfbs/justJeepsAPI/JustJeepsAPI-back-end/prisma/seeds/api-calls/api-csv-responses/shipping_rates_meyer.csv";

  let csvData = [];

  // Get all unique Meyer codes from the API response
  let allMeyerCodes = new Set();
  Object.values(allResponses).forEach((cityData) => {
    cityData.forEach((entry) => {
      allMeyerCodes.add(entry.sku); // 'sku' in the API response is actually the meyer_code
    });
  });

  allMeyerCodes = Array.from(allMeyerCodes);

  // Fetch SKU and shippingFreight from the Prisma Product table based on Meyer Code
  const productDetails = await prisma.product.findMany({
    where: {
      meyer_code: { in: allMeyerCodes },
    },
    select: {
      sku: true,
      brand_name: true,
      meyer_code: true,
      shippingFreight: true,
      price: true,
    },
  });

  // Convert product details into a lookup map
  const productMap = new Map();
  productDetails.forEach((product) => {
    productMap.set(product.meyer_code.trim(), {
      sku: product.sku || "N/A",
      brand_name: product.brand_name || "Unknown",
      shippingFreight: product.shippingFreight || "N/A",
      price: product.price !== null ? product.price.toFixed(2) : "N/A",  // Ensure price is formatted correctly

    });
  });

  // Build CSV rows for each Meyer Code
  allMeyerCodes.forEach((meyer_code) => {
    const product = productMap.get(meyer_code.trim()) || { 
      sku: "N/A", 
      brand_name: "Unknown", 
      shippingFreight: "N/A" ,
      price: "N/A",
    };

    const entry = {
      Meyer_Code: meyer_code,
      SKU: product.sku,
      Brand: product.brand_name,
      Shipping_Freight: product.shippingFreight,
      Vancouver: getShippingRate(allResponses, "VANCOUVER", meyer_code),
      Ontario: getShippingRate(allResponses, "TORONTO", meyer_code),
      Quebec: getShippingRate(allResponses, "GATINEAU", meyer_code),
      Alberta: getShippingRate(allResponses, "CALGARY", meyer_code),
      'Price': product.price,  // Correct field name case to match CSV headers
    };

    csvData.push(entry);
  });

  // Convert JSON to CSV
  const json2csvParser = new Parser({ fields: ["Meyer_Code", "SKU","Brand", "Shipping_Freight", "Vancouver", "Ontario", "Quebec", "Alberta","Price"] });
  const csv = json2csvParser.parse(csvData);

  fs.writeFileSync(filePath, csv);

  console.log(`✅ CSV file saved at: ${filePath}`);
};

// Helper function to get the cheapest shipping rate
const getShippingRate = (allResponses, city, meyer_code) => {
  if (!allResponses[city]) {
    console.log(`❌ No data found for city: ${city}`);
    return "N/A";
  }

  const record = allResponses[city].find((item) => item.sku.trim() === meyer_code.trim());
  return record ? record.cheapest_shipping : "N/A";
};



// Execute the function
getMeyerShippingRates();

