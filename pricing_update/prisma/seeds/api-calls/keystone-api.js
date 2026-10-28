const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const { parseString } = require("xml2js");

// Create an instance of PrismaClient
const prisma = new PrismaClient();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getAllSkus = async () => {
  const totalSkus = await prisma.product.count({
    where: {
      meyer_code: {
        not: "" // Exclude results where meyer_code is empty
      },
      status: 1
    }
  });

  console.log(`Total number of products with a Keyston Code: ${totalSkus}`);

  // console.log("Total count: ", totalCount);
  const skus = await prisma.product.findMany({
    where: {
      keystone_code: {
        not: "", // Exclude results where meyer_code is empty
      },
    },
    select: {
      keystone_code: true,
    },
    // skip: totalCount - 2000, // Skip the first (total count - 500) items
    // take: 1, // Limit the number of items to 500
  });
  return skus;
};

const KeystoneCost = async () => {
  const skus = await getAllSkus();
  // Create an array to store the items from all API calls
  const allItems = [];

  // Loop through each SKU and make individual API call for each SKU
  for (const sku of skus) {
    // Construct the SOAP XML request payload for each SKU
    let data = `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
            <CheckPriceBulk xmlns="http://eKeystone.com">
                <Key>${process.env.KEYSTONE_KEY}</Key>
                <FullAccountNo>${process.env.KEYSTONE_ACCOUNT}</FullAccountNo>
                <FullPartNo>${sku.keystone_code}</FullPartNo>
            </CheckPriceBulk>
        </soap:Body>
    </soap:Envelope>`;

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: "http://order.ekeystone.com/wselectronicorder/electronicorder.asmx",
      headers: {
        SOAPAction: "http://eKeystone.com/CheckPriceBulk",
        "Content-Type": "text/xml; charset=utf-8",
      },
      data: data,
    };

    try {
      const response = await axios.request(config);
      // Parse XML data into JavaScript object
      parseString(response.data, (err, result) => {
        if (err) {
          console.log(err);
        } else {
          // Extract Vendor, PartNumber, CustomerPrice, and Currency from the response
          const items = result["soap:Envelope"]["soap:Body"][0][
            "CheckPriceBulkResponse"
          ][0]["CheckPriceBulkResult"][0]["diffgr:diffgram"][0][
            "NewDataSet"
          ][0]["CheckPriceBulk"]
            .filter((item) => !item["ErrorMessage"]) // Filter out items with error messages
            .map((item) => ({
              keystone_code: sku.keystone_code,
              CustomerPrice: item["CustomerPrice"][0],
            }));
          // Push the items into the array
          allItems.push(...items);
        }
      });
    } catch (error) {
      console.log(error);
    }

    // Delay for 1 second between each API request to avoid rate limiting or IP blocking
    await delay(3000);
  };
  // console.log(allItems);
  return allItems;
};

const CheckInventory = async () => {

  const skus = await getAllSkus();

  const results = {};
  for (const sku of skus) {
    const data = `<?xml version="1.0" encoding="utf-8"?>
      <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
              <CheckInventory xmlns="http://eKeystone.com">
              <Key>${process.env.KEYSTONE_KEY}</Key>
              <FullAccountNo>${process.env.KEYSTONE_ACCOUNT}</FullAccountNo>
                  <FullPartNo>${sku.keystone_code}</FullPartNo>
              </CheckInventory>
          </soap:Body>
      </soap:Envelope>`;

    const config = {
      method: "post",
      maxBodyLength: Infinity,
      url: "http://order.ekeystone.com/wselectronicorder/electronicorder.asmx",
      headers: {
        SOAPAction: "http://eKeystone.com/CheckInventory",
        "Content-Type": "text/xml; charset=utf-8",
      },
      data: data,
    };

    try {
      const response = await axios.request(config);
      // Parse XML data into JavaScript object
      parseString(response.data, (err, result) => {
        if (err) {
          console.log(err);
        } else {
          // Extract CheckInventoryResult from the response
          const checkInventoryResult =
            result["soap:Envelope"]["soap:Body"][0][
              "CheckInventoryResponse"
            ][0]["CheckInventoryResult"][0];
          // Check if the result is not 'Invalid part number' and not 'Part is Blocked'
          if (
            !checkInventoryResult.toLowerCase().includes("invalid") && !checkInventoryResult.toLowerCase().includes("blocked")
          ) {
            // Add the result to the results object with SKU as key
            results[sku.keystone_code] = {
              keystone_code: sku.keystone_code,
              checkInventoryResult: checkInventoryResult,
            };
          }
        }
      });
    } catch (error) {
      console.log(error.code);
    }
    await delay(3000);
  }

  // Log the results object after all API calls are made
  // console.log("Results: ", results);
  return results;
};

async function getResultsFromCostAndInventoryKeystone() {
  try {
    const resultsFromCheckInventory = await CheckInventory();
    const resultsFromCost = await KeystoneCost();
    // console.log("resultsFromCheckInventory: ", resultsFromCheckInventory);
    // console.log("resultsFromCost: ", resultsFromCost);

    //combine the results
    const combinedResult = {};
    // Merge results from CheckInventory
    for (const key in resultsFromCheckInventory) {
      if (resultsFromCheckInventory.hasOwnProperty(key)) {
        combinedResult[key] = {
          ...resultsFromCheckInventory[key],
          CustomerPrice: 0, // Placeholder for CustomerPrice
        };
      }
    }

    // Merge results from Cost
    resultsFromCost.forEach((costResult) => {
      const { keystone_code, CustomerPrice } = costResult;
      if (combinedResult.hasOwnProperty(keystone_code)) {
        combinedResult[keystone_code].CustomerPrice = CustomerPrice;
      }
    });

    // console.log('combinedResult',combinedResult); // Output the combined result
    return combinedResult;
  } catch (error) {
    console.error("Error fetching results from CheckInventory: ", error);
  }
}

// getResultsFromCostAndInventoryKeystone();

module.exports = getResultsFromCostAndInventoryKeystone;
