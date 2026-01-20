const { PrismaClient } = require("@prisma/client");
// const data = require("../hard-code_data/partsEngine_data.js");
const partsEngine = require("../api-calls/partsEngine-api.js");



const prisma = new PrismaClient();

async function seedPartsEngine() {
  let counter = 0; // Counter variable to keep track of added and updated products

  try {
    const data = await partsEngine();
    console.log("data from partsEngine >>>>", data);

    // Loop through the data from data.js
    for (const link of data.links) {
      try {
        if (!link.sku) {
          continue; // Skip to the next iteration if link.sku is missing
        }

        // const searchableSku = link.sku;

        // ******
        // let rawSku = link.sku;

        // // Only adjust SKU if it's Omix (based on the URL ending)
        // if (
        //   link.link?.endsWith("-vp-omix-ada-614.aspx") &&
        //   /^\d+-\d+$/.test(rawSku)
        // ) {
        //   rawSku = rawSku.replace(/-(\d+)$/, '.$1');
        // }
        
        // const searchableSku = rawSku;

        // ******


        // Normalize SKUs depending on brand-specific rules
        let rawSku = link.sku;

        if (
          link.link?.endsWith("-vp-omix-ada-614.aspx") ||
          link.link?.endsWith("-vp-rugged-ridge-160.aspx")
        ) {
          if (/^\d+-\d+$/.test(rawSku)) {
            rawSku = rawSku.replace(/-(\d+)$/, '.$1');
          }
        }
        
        // Normalize Rough Country SKUs (if ends with -X where X is a single capital letter)
        if (link.link?.endsWith("-vp-rough-country-384.aspx")) {
          rawSku = rawSku.replace(/-(?=[A-Z]$)/, '_');
        }
        
        // Normalize Z Automotive SKUs (replace all dashes with underscores)
        if (link.link?.endsWith("-vp-z-automotive-2560.aspx")) {
          rawSku = rawSku.replace(/-/g, '_');
        }

        // Normalize AirBedz SKUs (replace only the last dash with underscore)
        if (link.link?.endsWith("-vp-airbedz-270.aspx")) {
  rawSku = rawSku.replace(/-(?=[^-]*$)/, '_'); // Replaces only the last hyphen
        }

        // Chemical Guys: replace only the last dash → underscore
        if (link.link?.endsWith("-vp-chemical-guys-1309.aspx")) {
  rawSku = rawSku.replace(/-(?=[^-]*$)/, '_');
        }

        // DV8 Offroad: replace first dash with dot for pattern A1-xxx (e.g., S4-, R3-, etc.)
        if (link.link?.endsWith("-vp-dv8-offroad-911.aspx")) {
        if (/^[A-Z]\d-/.test(rawSku)) {
        rawSku = rawSku.replace(/-/, '.');
         }
        }

        //BESTOP: -vp-bestop-15.aspx > REMOVE THE DASHES
        if (link.link?.endsWith("-vp-bestop-15.aspx")) {
          rawSku = rawSku.replace(/-/g, '');
        }
     
        const searchableSku = rawSku;
        
        // ******        
        


          //console.log("sku from partsEngine >>>>", link.sku and searchableSku);
          console.log("sku from partsEngine >>>>", link.sku);
          console.log("sku from (searchable sku) >>>>", searchableSku);
          // console.log("sku from partsEngine >>>>", link.sku);
        


        // Fetch the corresponding Product model based on the searchableSku
        const product = await prisma.product.findFirst({
          where: {
            searchableSku: searchableSku,
          },
        });

        if (product) {
          const jjPrefix = product.jj_prefix; // Fetch jj_prefix from Product model
          const productSku = `${jjPrefix}-${searchableSku}`; // Construct productSku by adding jj_prefix to searchableSku

          // Check if the CompetitorProduct already exists in the database
          const competitorProduct = await prisma.competitorProduct.findFirst({
            where: {
              competitor_id: 3,
              product_sku: productSku,
            },
          });

          if (competitorProduct) {
            // If the CompetitorProduct already exists, update its data
            await prisma.competitorProduct.update({
              where: {
                id: competitorProduct.id,
              },
              data: {
                competitor_price: parseFloat(link.price.replace(/[^0-9.-]+/g,""))*1.00,
                product_url: link.link,
              },
            });

            // Increment the counter for updated products
            counter++;

            // console.log(
            //   `SKU: ${sku} -> searchableSku: ${searchableSku} -> jj_prefix: ${jjPrefix} -> productSku: ${productSku} -> CompetitorProduct updated`
            // );
          } else {
            // If the CompetitorProduct does not exist, create a new one
            await prisma.competitorProduct.create({
              data: {
                competitor_id: 3,
                product_sku: productSku,
                competitor_price: parseFloat(link.price.replace(/[^0-9.-]+/g,""))*1.00,
                product_url: link.link,
              },
            });

            // Increment the counter for added products
            counter++;

            // console.log(
            //   `SKU: ${sku} -> searchableSku: ${searchableSku} -> jj_prefix: ${jjPrefix} -> productSku: ${productSku} -> CompetitorProduct created`
            // );
          }
        } else {
          // console.log(
          // `SKU: ${sku} -> No corresponding Product found for searchableSku: ${searchableSku}`
          // );
        }
      } catch (error) {
        console.error(error);
        continue; // Skip to the next iteration if an error occurs
      }
    }

    console.log(`${counter} competitor products were added and updated successfully`);
  } catch (error) {
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}



module.exports = seedPartsEngine;
seedPartsEngine();
