
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

puppeteer.use(StealthPlugin());

async function scrapePart(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
const status = response?.status();
if (status !== 200) throw new Error(`Status ${status}`);

// ⏩ Fail fast on search result pages
const isSearchPage = await page.evaluate(() => {
  const h1 = document.querySelector("h1");
  return h1 && h1.textContent.includes("results for");
});
if (isSearchPage) {
  throw new Error("Redirected to search page");
}

// Proceed only on valid product pages
await page.waitForSelector("#PDPTitleBoxV2 h1 b span:nth-of-type(2)", { timeout: 1500 });
await page.waitForFunction(
  () => {
    const el = document.querySelector("#variantPrice");
    return el && el.textContent && el.textContent.trim().length > 1;
  },
  { timeout: 2000 }
);

    // const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // const status = response?.status();

    // if (status !== 200) throw new Error(`Status ${status}`);

    // // Wait for the SKU element to appear
    // await page.waitForSelector("#PDPTitleBoxV2 h1 b span:nth-of-type(2)", { timeout: 1500 });

    // // Wait for the price element to exist AND contain text
    // await page.waitForFunction(
    //   () => {
    //     const el = document.querySelector("#variantPrice");
    //     return el && el.textContent && el.textContent.trim().length > 1;
    //   },
    //   { timeout: 2000 }
    // );



    // ✅ Extract the data now that we're sure it's visible
    const data = await page.evaluate(() => {
      const skuEl = document.querySelector("#PDPTitleBoxV2 h1 b span:nth-of-type(2)");
      const priceEl = document.querySelector("#variantPrice");

      const sku = skuEl?.textContent?.trim() || null;
      const priceText = priceEl?.textContent?.replace(/[^\d.]/g, "");
      const price = priceText && !isNaN(priceText) ? parseFloat(priceText).toFixed(2) : null;

      return { sku, price };
    });

    if (!data.sku || !data.price) {
      throw new Error(`Missing or invalid SKU (${data.sku}) or Price (${data.price})`);
    }

    return {
      sku: data.sku,
      price: data.price,
    };
  } catch (err) {
    console.warn(`❌ scrapePart error for ${url}: ${err.message}`);
    throw err;
  }
}

module.exports = scrapePart;







// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// const fs = require('fs');
// const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// puppeteer.use(StealthPlugin());

// (async () => {
//   const urls = fs.readFileSync(__dirname + '/urls.txt', 'utf8').split('\n').filter(Boolean);
//   const total = urls.length;
//   const startTime = Date.now();

//   const browser = await puppeteer.launch({ headless: true });
//   const page = await browser.newPage();

//   const results = [];

//   for (let i = 0; i < urls.length; i++) {
//     const url = urls[i];
//     console.log(`🔍 [${i + 1}/${total}] Scraping: ${url}`);

//     let status = 'N/A';

//     try {
//       const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
//       status = response?.status() || 'No Response';

//       const data = await page.evaluate(() => {
//         const getXPathText = (xpath) => {
//           const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
//           return result.singleNodeValue?.textContent.trim() || 'N/A';
//         };

//         const getXPathAttr = (xpath, attr) => {
//           const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
//           return result.singleNodeValue?.getAttribute(attr) || 'N/A';
//         };

//         const sku = getXPathText('//*[@id="PDPTitleBoxV2"]/div/h1/b/span[2]');
//         const price = getXPathAttr('//*[@id="PDPVehicleSelectorV2"]/div/div/div/div[1]/meta', 'content');
//         const title = document.title;

//         return { sku, price, title };
//       });

//       results.push({ url, status, ...data });

//     } catch (err) {
//       console.error(`❌ Failed on: ${url}`, err.message);
//       results.push({ url, status: 'Error', sku: 'Error', price: 'Error', title: 'Error' });
//     }

//     // ETA calculation
//     const elapsed = (Date.now() - startTime) / 1000;
//     const avgTime = elapsed / (i + 1);
//     const eta = avgTime * (total - (i + 1));
//     console.log(`🕒 Elapsed: ${elapsed.toFixed(0)}s | ETA: ${(eta / 60).toFixed(1)} min`);

//     // Delay to avoid blocks
//     await new Promise((r) => setTimeout(r, Math.random() * 4000 + 3000)); // 3–7s
//   }

//   await browser.close();
//   console.log('✅ All URLs processed. Closing browser...');
//   console.log('Writing results to CSV...');

//   const csvWriter = createCsvWriter({
//     path: __dirname + '/results.csv',
//     header: [
//       { id: 'url', title: 'URL' },
//       { id: 'status', title: 'HTTP Status' },
//       { id: 'sku', title: 'SKU' },
//       { id: 'price', title: 'Price' },
//       { id: 'title', title: 'Title' },
//     ]
//   });

//   await csvWriter.writeRecords(results);
//   console.log('✅ All done! Data saved to results.csv');

//   const totalTime = (Date.now() - startTime) / 1000;
//   console.log(`🕒 Total time: ${totalTime.toFixed(0)}s (${(totalTime / 60).toFixed(1)} minutes)`);
// })();

