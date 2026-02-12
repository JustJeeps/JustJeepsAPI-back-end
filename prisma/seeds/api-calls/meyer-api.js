
// const axios = require("axios");

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// function isRetryableHttp(err) {
//   const status = err?.response?.status;
//   if (!status) return true; // network / timeout
//   return [408, 425, 429, 500, 502, 503, 504].includes(status);
// }

// /**
//  * Fetch one Meyer item by ItemNumber.
//  * Returns either:
//  *  - array like original: [ { ItemNumber, CustomerPrice, QtyAvailable, PartStatus, Length, Width, Height, Weight, ... } ]
//  *  - or { statusCode, errorMessage } on failure to keep original "skip if data.statusCode" compatibility
//  */
// async function fetchMeyerItem(itemNumber, opts = {}) {
//   const {
//     timeoutMs = Number(process.env.MEYER_TIMEOUT_MS || 30000),
//     maxRetries = Number(process.env.MEYER_RETRY_MAX || 5),
//     baseDelayMs = Number(process.env.MEYER_RETRY_DELAY_MS || 400),
//     minDelayBetweenCallsMs = Number(process.env.MEYER_MIN_DELAY_MS || 0),
//   } = opts;

//   const url = `https://meyerapi.meyerdistributing.com/http/default/ProdAPI/v2/ItemInformation?ItemNumber=${encodeURIComponent(
//     itemNumber
//   )}`;

//   // Your original code included a JSON body but method was "get".
//   // We keep GET and headers that matter (Authorization).
//   const config = {
//     method: "get",
//     url,
//     timeout: timeoutMs,
//     headers: {
//       Authorization: `Espresso ${process.env.MEYER_KEY}`,
//       "Content-Type": "application/json",
//     },
//     // If Meyer truly requires username/password in-body, you can re-add data here,
//     // but most APIs ignore body on GET.
//   };

//   for (let attempt = 1; attempt <= maxRetries; attempt++) {
//     try {
//       const res = await axios.request(config);
//       if (minDelayBetweenCallsMs > 0) await sleep(minDelayBetweenCallsMs);
//       return res.data;
//     } catch (err) {
//       const retryable = isRetryableHttp(err);
//       if (!retryable || attempt === maxRetries) {
//         const status = err?.response?.status;
//         const msg =
//           err?.response?.data?.errorMessage ||
//           err?.message ||
//           "Unknown Meyer API error";
//         return {
//           statusCode: status || 500,
//           errorMessage: msg,
//           itemNumber,
//         };
//       }
//       const backoff = baseDelayMs * Math.pow(2, attempt - 1);
//       await sleep(backoff);
//     }
//   }

//   return { statusCode: 500, errorMessage: "Unexpected retry loop exit", itemNumber };
// }

// /**
//  * Concurrency pool runner for many ItemNumbers.
//  * Returns array aligned to input order: each element is response data (array) or {statusCode,...}
//  */
// async function fetchMeyerItems(itemNumbers, opts = {}) {
//   const concurrency = Number(opts.concurrency || process.env.MEYER_CONCURRENCY || 6);

//   let idx = 0;
//   const results = new Array(itemNumbers.length);

//   const worker = async () => {
//     while (true) {
//       const current = idx++;
//       if (current >= itemNumbers.length) return;
//       const item = itemNumbers[current];
//       results[current] = await fetchMeyerItem(item, opts);
//     }
//   };

//   const workers = [];
//   for (let i = 0; i < concurrency; i++) workers.push(worker());
//   await Promise.all(workers);

//   return results;
// }

// module.exports = {
//   fetchMeyerItem,
//   fetchMeyerItems,
// };



const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

// Create an instance of PrismaClient
const prisma = new PrismaClient();

const MeyerCost = async () => {
  try {
    // Get total number of products with a meyer_code and status=1
    const totalSkus = await prisma.product.count({
      where: {
        meyer_code: {
          not: "", // Exclude results where meyer_code is empty
        },
        brand_name: {
          // in:[ "BESTOP"]   
          //        //   in:[
        //     // "Alloy USA",
        //     // "American Expedition Vehicles",
        //     // "ARB",
        //     // "BESTOP",
        //     // "BF Goodrich Tires",
        //     // "Bilstein",
        //     // "Black Rhino",
        //     // "Body Armor 4x4",
        //     // "BUSHWACKER",
        //     // "Crown Automotive",
        //     // "Dana Spicer",
        //     // "DV8 OffRoad",
        //     // "EATON",
        //     // "Fab Fours",
        //     // "Fabtech",
        //     // "Factor 55",
        //     // "Fishbone Offroad",
        //     // "FlowMaster",
        //     // "Fox Racing",
        //     // "Fuel Off-Road",
        //     // "G2 Axle & Gear",
        //     // "Garvin Wilderness",
        //     // "Go Rhino",
        //     // "J.W. Speaker",
        //     // "K&N",
        //     // "KC HILITES",
        //     // "Kentrol",
        //     // "KMC Wheels",
        //     // "Lange Originals",
        //     // "MBRP Inc",
        //     "MICKEY THOMPSON Tires/Wheels",
        //     "MOPAR",
        //     "N-Fab",
        //     "OMIX-ADA",
        //     "Oracle Lighting",
        //     "Paramount Automotive",
        //     "Poison Spyder Customs",
        //     "PRO COMP Alloy Wheels",
        //     "PRO COMP Steel Wheels",
        //     "PRO COMP Suspension",
        //     "PRO COMP Tires",
        //     "Quadratec",
        //     "QuadraTop",
        //     "Quake LED",
        //     "Rampage Products",
        //     "ReadyLIFT",
        //     "Rhino-Rack",
        //     "Rigid Industries",
        //     "Rock Slide Engineering",
        //     "Rough Country",
        //     "RT Off-Road",
        //     "Rubicon Express",
        //     "Rugged Ridge",
        //     "Rust Buster",
        //     "Skyjacker Suspension",
        //     "Smittybilt",
        //     "Steer Smarts",
        //     "Synergy MFG",
        //     "TeraFlex",
        //     "Thule Racks",
        //     "Tuffy Products",
        //     "Vertically Driven Products",
        //     "WARN",
        //     "Westin Automotive",
        //     "Yukon",
        //     "Z Automotive",
        //     "Zone Offroad",
        //     "ZROADZ",
        //     "Diver Down",
        //     "TACTIK",
        //     "MasterTop"
        // ],
          // in:["AccuPart", "Addictive Desert Designs", "aFe Power", "Alpine", "Armorlite", "AMP Research", "Aries Automotive", "American Trail Products", "Baja Designs", "Black Rock Wheels", "BedRug", "Boomerang Enterprises", "Bolt Lock", "Bubba Rope", "Borgeson", "Centerforce", "Cobra Electronics", "Corsa Performance", "Carnivore", "Daystar", "Dirty Life", "DynoMax Exhaust", "Dynatrac", "EBC Brakes", "Energy Suspension", "Exposed Racks", "Fairchild Industries", "Falken WildPeak", "Gibson Performance", "Gorilla Automotive", "Grant Products", "HELLA", "Hi-Lift Jack", "Hopkins", "Husky Liners", "Havoc Offroad", "JBA Performance Exhaust", "JKS Manufacturing", "Kicker Jeep Audio & Electronics", "KeyParts", "LoD Offroad", "LUK Clutches", "Lube Locker", "Lynx", "McGard Wheel Locks", "MD Juan", "MagnaFlow", "Motive Gear", "Magnum by Raptor Series", "MORryde", "Misch 4x4", "Napier Sportz", "Nitto Tire", "Old Man Emu", "Overtread", "Overland Vehicle Systems", "POR-15", "PSC Steering", "Power Stop", "Putco", "Rancho", "RES-Q", "Rival 4x4", "RockNob", "RotoPax", "RSI", "Seatbelt Solutions", "SpiderTrax", "Superlift", "Superwinch", "TrailFX", "Toyo Tires", "TuxMat", "VersaHitch", "Warrior Products", "XG Cargo"]



        },
        status: 1,
      },
    });

    console.log(`Total number of products with a Meyer Code: ${totalSkus}`);

    const skus = await prisma.product.findMany({
      where: {
        meyer_code: {
          not: "", // Exclude results where meyer_code is empty
        },
        brand_name: {
          // in:[ "BESTOP"]   
        
    
        },
        status: 1,
      },
      select: {
        meyer_code: true,
      },
    });

    const chunkedSkus = [];
    for (let i = 0; i < skus.length; i += 100) {
      chunkedSkus.push(skus.slice(i, i + 100));
    }

    const makeRequests = async (chunk, chunkIndex) => {
      console.log(`Starting chunk ${chunkIndex}...`);
      const responses = [];
      for (let i = 0; i < chunk.length; i++) {
        const sku = chunk[i].meyer_code;
        try {
          let data = JSON.stringify({
            username: process.env.MEYER_USERNAME,
            password: process.env.MEYER_PASSWORD,
            ItemNumber: sku,
          });

          let config = {
            method: "get",
            maxBodyLength: Infinity,
            url: `https://meyerapi.meyerdistributing.com/http/default/ProdAPI/v2/ItemInformation?ItemNumber=${sku}`,
            headers: {
              Authorization: `Espresso ${process.env.MEYER_KEY}`,
              "Content-Type": "application/json",
            },
            data: data,
          };

          const response = await axios.request(config);
          console.log(`Success for SKU ${sku} from Meyer API Call`);
          responses.push(response.data);
        } catch (error) {
          console.log(`Error for SKU ${sku} from Meyer API Call: ${error}`);
          responses.push(null); // Push null for error responses
        }
        // Add a delay of 1 second between API requests
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.log(`Chunk ${chunkIndex} completed.`);
      // Add a delay of 60 seconds before calling the next chunk
      await new Promise((resolve) => setTimeout(resolve, 600));

      return responses;
    };

    const flattenedResponses = [];
    console.time("Overall execution time");

    for (let i = 0; i < chunkedSkus.length; i++) {
      const chunk = chunkedSkus[i];
      const chunkIndex = i + 1;
      const responses = await makeRequests(chunk, chunkIndex);
      flattenedResponses.push(...responses);
    }

    console.timeEnd("Overall execution time");

    console.log(flattenedResponses);
    return flattenedResponses;

    // const requests = chunkedSkus.map((chunk, index) => makeRequests(chunk, index + 1)); // Increment index by 1

    // const flattenResponses = (responses) => {
    //   return responses.reduce((acc, curr) => {
    //     return acc.concat(curr);
    //   }, []);
    // };

    // const responses = await Promise.all(requests);
    // const flattenedResponses = flattenResponses(responses);

    // console.log(flattenedResponses);
    // return flattenedResponses;
  } catch (error) {
    console.log(error);
  }
};

// Call the async function
// MeyerCost();

module.exports = MeyerCost;
