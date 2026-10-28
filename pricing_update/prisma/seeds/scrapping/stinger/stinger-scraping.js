const puppeteer = require("puppeteer");
const fs = require("fs");
const { stringify } = require("csv-stringify/sync");
const path = require("path");

const OUTPUT_DIR = __dirname;

const CATEGORY_URLS = [
  // "https://stingersolutions.com/collections/infotainment",
  // "https://stingersolutions.com/collections/audio",
  "https://stingersolutions.com/collections/lighting",
  // "https://stingersolutions.com/collections/remote-starters",
  // "https://stingersolutions.com/collections/safety"
];

const NAV_TIMEOUT_MS = 60000;
const MAX_RETRIES = 4;
const PRODUCT_DELAY_MS = [700, 1400];
const CATEGORY_DELAY_MS = [800, 1600];
const FLUSH_EVERY = 1;
const CHECKPOINT_FILE = "stinger_checkpoint.json";
const CSV_FILE = "stinger_products.csv";

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function jitter([min, max]) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function setupPage(page) {
  await page.setUserAgent(UAS[Math.floor(Math.random() * UAS.length)]);
  await page.setViewport({ width: 1366, height: 850 });
  await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.setDefaultTimeout(NAV_TIMEOUT_MS);
  await page.setCacheEnabled(true);

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const rtype = req.resourceType();
    if (["image", "media", "font", "stylesheet", "fetch"].includes(rtype)) {
      return req.abort();
    }
    req.continue();
  });
}

async function safeGoto(page, url, { retries = MAX_RETRIES, label = "page" } = {}) {
  const waitModes = ["networkidle2", "domcontentloaded"];
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: waitModes[i % waitModes.length], timeout: NAV_TIMEOUT_MS });
      return true;
    } catch (err) {
      const backoff = 1000 * Math.pow(2, i);
      console.warn(`⚠️ Timeout loading ${url} (${label}) retry ${i + 1}/${retries}; backoff ${backoff}ms`);
      await delay(backoff);
    }
  }
  console.error(`❌ Failed to load ${url} after ${retries} retries`);
  return false;
}

function loadCheckpoint() {
  const cpPath = path.join(OUTPUT_DIR, CHECKPOINT_FILE);
  if (fs.existsSync(cpPath)) {
    try {
      return JSON.parse(fs.readFileSync(cpPath, "utf8"));
    } catch {
      return { visited: {}, data: [] };
    }
  }
  return { visited: {}, data: [] };
}

function saveCheckpoint(checkpoint) {
  const cpPath = path.join(OUTPUT_DIR, CHECKPOINT_FILE);
  fs.writeFileSync(cpPath, JSON.stringify(checkpoint, null, 2));
  console.log(`💾 Checkpoint saved → ${cpPath}`);
}

function flushCSV(rows) {
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = (r.sku || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  const csv = stringify(deduped, {
    header: true,
    columns: ["sku", "title", "price", "url", "category"]  // ✅ include category
  });

  const csvPath = path.join(OUTPUT_DIR, CSV_FILE);
  fs.writeFileSync(csvPath, csv);
  console.log(`💾 CSV flushed: ${deduped.length} unique SKUs → ${csvPath}`);
}

async function extractProductsFromCategory(catPage) {
  await catPage.waitForSelector("a.product-item__title", { timeout: 25000 }).catch(() => {});
  const links = await catPage.$$eval(
    "a.product-item__title.text--strong.link, a.full-unstyled-link",
    (els) => els.map((e) => e.href).filter(Boolean)
  );
  return [...new Set(links)];
}

async function getPaginationNext(catPage) {
  const next = await catPage.$("a.pagination__next.link, a[rel='next']");
  if (!next) return null;
  return await catPage.$eval("a.pagination__next.link, a[rel='next']", (el) => el.href);
}

async function scrapeProduct(browser, url, category) {
  const page = await browser.newPage();
  try {
    await setupPage(page);
    if (!(await safeGoto(page, url, { label: "product" }))) return null;

    const selTitle = "h1.product__title, h1.product-meta__title, h1";
    const selSku = ".product-meta__sku-number, [data-product-sku], .product__sku, .sku";
    const selPrice = ".price [data-money], .price span:not(.visually-hidden), .price__regular .price-item--regular, .price__current";

    await page.waitForFunction(
      (t, s, p) =>
        !!document.querySelector(t) || !!document.querySelector(s) || !!document.querySelector(p),
      { timeout: 20000 },
      selTitle,
      selSku,
      selPrice
    ).catch(() => {});

    const data = await page.evaluate(
      (selTitle, selSku, selPrice) => {
        const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
        const title = pick(selTitle);
        let sku =
          pick(selSku) ||
          document.querySelector("[data-product-sku]")?.getAttribute("data-product-sku") ||
          "";
        const price = pick(selPrice);
        return { title, sku, price, url: location.href };
      },
      selTitle,
      selSku,
      selPrice
    );

    // ✅ Include category in result
    data.category = category;

    return data;
  } catch (e) {
    console.warn(`⚠️ Error scraping product ${url}: ${e.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
    ],
  });

  const catPage = await browser.newPage();
  await setupPage(catPage);

  const checkpoint = loadCheckpoint();
  const visited = checkpoint.visited || {};
  const scrapedData = checkpoint.data || [];

  function gracefulExit(code = 0) {
    try {
      saveCheckpoint({ visited, data: scrapedData });
      flushCSV(scrapedData);
    } catch (_) {}
    process.exit(code);
  }
  process.on("SIGINT", () => {
    console.log("\n👋 Caught SIGINT (Ctrl+C) — saving files before exit…");
    gracefulExit(0);
  });
  process.on("SIGTERM", () => {
    console.log("\n👋 Caught SIGTERM — saving files before exit…");
    gracefulExit(0);
  });

  let grandCount = scrapedData.length;

  for (const categoryUrl of CATEGORY_URLS) {
    console.log(`\n🚀 Starting category: ${categoryUrl}`);
    let currentPage = categoryUrl;
    let categoryCount = 0;

    const categoryMatch = categoryUrl.match(/collections\/([^/?#]+)/i);
    const category = categoryMatch ? categoryMatch[1] : "unknown";

    while (currentPage) {
      if (!(await safeGoto(catPage, currentPage, { label: "category" }))) break;

      const productLinks = await extractProductsFromCategory(catPage);
      console.log(`📄 Found ${productLinks.length} products on this page`);

      for (const productUrl of productLinks) {
        if (visited[productUrl]) continue;

        let productData = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          productData = await scrapeProduct(browser, productUrl, category);
          if (productData && (productData.sku || productData.title)) break;
          console.warn(`🔁 Retry ${attempt}/${MAX_RETRIES} for ${productUrl}`);
          await delay(500 * attempt);
        }

        categoryCount++;
        grandCount++;

        if (productData) {
          console.log(`[${grandCount}] ✅ SKU: ${productData.sku || "(no-sku)"} | Price: ${productData.price || ""}`);
          scrapedData.push(productData);
        } else {
          console.log(`[${grandCount}] ❌ Failed: ${productUrl}`);
        }

        visited[productUrl] = true;

        if (scrapedData.length % FLUSH_EVERY === 0) {
          saveCheckpoint({ visited, data: scrapedData });
          flushCSV(scrapedData);
        }

        await delay(jitter(PRODUCT_DELAY_MS));
      }

      const nextPage = await getPaginationNext(catPage);
      currentPage = nextPage ? nextPage : null;
      if (nextPage) {
        console.log(`➡️ Moving to next page: ${nextPage}`);
        await delay(jitter(CATEGORY_DELAY_MS));
      }
    }

    console.log(`✅ Finished category: ${categoryUrl} | Total scraped here: ${categoryCount}`);
  }

  saveCheckpoint({ visited, data: scrapedData });
  flushCSV(scrapedData);

  await browser.close();

  const unique = new Set(scrapedData.map((r) => (r.sku || "").trim())).size;
  console.log(`\n🎯 TOTAL SKUs SCRAPED (unique): ${unique}`);
  console.log(`✅ Data saved to ${path.join(OUTPUT_DIR, CSV_FILE)} | Checkpoint: ${path.join(OUTPUT_DIR, CHECKPOINT_FILE)}`);
})();





// // stinger-scraping.js
// const puppeteer = require("puppeteer");
// const fs = require("fs");
// const { stringify } = require("csv-stringify/sync");
// const path = require("path");

// // Always write outputs next to THIS file (not the shell's CWD)
// const OUTPUT_DIR = __dirname;

// const CATEGORY_URLS = [
//   "https://stingersolutions.com/collections/infotainment",
//   "https://stingersolutions.com/collections/audio",
//   // "https://stingersolutions.com/collections/lighting",
//   "https://stingersolutions.com/collections/remote-starters",
//   "https://stingersolutions.com/collections/safety"
// ];

// // ---- Tunables ----
// const NAV_TIMEOUT_MS = 60000;
// const MAX_RETRIES = 4;
// const PRODUCT_DELAY_MS = [700, 1400]; // min, max (jitter)
// const CATEGORY_DELAY_MS = [800, 1600];
// const FLUSH_EVERY = 1; // flush CSV every product (was 25)
// const CHECKPOINT_FILE = "stinger_checkpoint.json";
// const CSV_FILE = "stinger_products.csv";

// // Some friendly desktop UAs
// const UAS = [
//   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
//   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
//   "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
// ];

// function delay(ms) {
//   return new Promise((res) => setTimeout(res, ms));
// }

// function jitter([min, max]) {
//   return Math.floor(Math.random() * (max - min + 1)) + min;
// }

// async function setupPage(page) {
//   await page.setUserAgent(UAS[Math.floor(Math.random() * UAS.length)]);
//   await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
//   await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
//   await page.setDefaultTimeout(NAV_TIMEOUT_MS);
//   await page.setCacheEnabled(true);

//   // Block heavy resources
//   await page.setRequestInterception(true);
//   page.on("request", (req) => {
//     const rtype = req.resourceType();
//     if (rtype === "image" || rtype === "media" || rtype === "font" || rtype === "stylesheet" || rtype === "fetch") {
//       return req.abort();
//     }
//     req.continue();
//   });
// }

// async function safeGoto(page, url, { retries = MAX_RETRIES, label = "page" } = {}) {
//   const waitModes = ["networkidle2", "domcontentloaded"];
//   for (let i = 0; i < retries; i++) {
//     try {
//       await page.goto(url, { waitUntil: waitModes[i % waitModes.length], timeout: NAV_TIMEOUT_MS });
//       return true;
//     } catch (err) {
//       const backoff = 1000 * Math.pow(2, i);
//       console.warn(`⚠️ Timeout loading ${url} (${label}) retry ${i + 1}/${retries}; backoff ${backoff}ms`);
//       await delay(backoff);
//     }
//   }
//   console.error(`❌ Failed to load ${url} after ${retries} retries`);
//   return false;
// }

// function loadCheckpoint() {
//   const cpPath = path.join(OUTPUT_DIR, CHECKPOINT_FILE);
//   if (fs.existsSync(cpPath)) {
//     try {
//       return JSON.parse(fs.readFileSync(cpPath, "utf8"));
//     } catch {
//       return { visited: {}, data: [] };
//     }
//   }
//   return { visited: {}, data: [] };
// }

// function saveCheckpoint(checkpoint) {
//   const cpPath = path.join(OUTPUT_DIR, CHECKPOINT_FILE);
//   fs.writeFileSync(cpPath, JSON.stringify(checkpoint, null, 2));
//   console.log(`💾 Checkpoint saved → ${cpPath}`);
// }

// function flushCSV(rows) {
//   // Dedup by SKU (keep first occurrence)
//   const seen = new Set();
//   const deduped = [];
//   for (const r of rows) {
//     const key = (r.sku || "").trim();
//     if (!key) continue;
//     if (seen.has(key)) continue;
//     seen.add(key);
//     deduped.push(r);
//   }

//   const csv = stringify(deduped, { header: true });
//   const csvPath = path.join(OUTPUT_DIR, CSV_FILE);
//   fs.writeFileSync(csvPath, csv);
//   console.log(`💾 CSV flushed: ${deduped.length} unique SKUs → ${csvPath}`);
// }

// async function extractProductsFromCategory(catPage) {
//   await catPage.waitForSelector("a.product-item__title", { timeout: 25000 }).catch(() => {});
//   const links = await catPage.$$eval(
//     "a.product-item__title.text--strong.link, a.full-unstyled-link",
//     (els) => els.map((e) => e.href).filter(Boolean)
//   );
//   return [...new Set(links)];
// }

// async function getPaginationNext(catPage) {
//   const next = await catPage.$("a.pagination__next.link, a[rel='next']");
//   if (!next) return null;
//   return await catPage.$eval("a.pagination__next.link, a[rel='next']", (el) => el.href);
// }

// async function scrapeProduct(browser, url) {
//   const page = await browser.newPage();
//   try {
//     await setupPage(page);
//     if (!(await safeGoto(page, url, { label: "product" }))) return null;

//     // Try multiple selectors; Shopify themes vary
//     const selTitle = "h1.product__title, h1.product-meta__title, h1";
//     const selSku = ".product-meta__sku-number, [data-product-sku], .product__sku, .sku";
//     const selPrice = ".price [data-money], .price span:not(.visually-hidden), .price__regular .price-item--regular, .price__current";

//     // Wait for at least a title or SKU or price
//     await page.waitForFunction(
//       (t, s, p) =>
//         !!document.querySelector(t) || !!document.querySelector(s) || !!document.querySelector(p),
//       { timeout: 20000 },
//       selTitle,
//       selSku,
//       selPrice
//     ).catch(() => {});

//     const data = await page.evaluate(
//       (selTitle, selSku, selPrice) => {
//         const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
//         const title = pick(selTitle);
//         let sku =
//           pick(selSku) ||
//           document.querySelector("[data-product-sku]")?.getAttribute("data-product-sku") ||
//           "";
//         const price = pick(selPrice);
//         return { title, sku, price, url: location.href };
//       },
//       selTitle,
//       selSku,
//       selPrice
//     );

//     return data;
//   } catch (e) {
//     console.warn(`⚠️ Error scraping product ${url}: ${e.message}`);
//     return null;
//   } finally {
//     await page.close().catch(() => {});
//   }
// }

// (async () => {
//   const browser = await puppeteer.launch({
//     headless: true,
//     args: [
//       "--no-sandbox",
//       "--disable-setuid-sandbox",
//       "--disable-dev-shm-usage",
//       "--disable-gpu",
//       "--no-first-run",
//       "--no-zygote",
//     ],
//   });

//   const catPage = await browser.newPage();
//   await setupPage(catPage);

//   const checkpoint = loadCheckpoint();
//   const visited = checkpoint.visited || {};
//   const scrapedData = checkpoint.data || [];

//   // Graceful shutdown: flush on Ctrl+C / kill
//   function gracefulExit(code = 0) {
//     try {
//       saveCheckpoint({ visited, data: scrapedData });
//       flushCSV(scrapedData);
//     } catch (_) {}
//     process.exit(code);
//   }
//   process.on("SIGINT", () => {
//     console.log("\n👋 Caught SIGINT (Ctrl+C) — saving files before exit…");
//     gracefulExit(0);
//   });
//   process.on("SIGTERM", () => {
//     console.log("\n👋 Caught SIGTERM — saving files before exit…");
//     gracefulExit(0);
//   });

//   let grandCount = scrapedData.length;

//   for (const categoryUrl of CATEGORY_URLS) {
//     console.log(`\n🚀 Starting category: ${categoryUrl}`);
//     let currentPage = categoryUrl;
//     let categoryCount = 0;

//     while (currentPage) {
//       if (!(await safeGoto(catPage, currentPage, { label: "category" }))) break;

//       const productLinks = await extractProductsFromCategory(catPage);
//       console.log(`📄 Found ${productLinks.length} products on this page`);

//       // Scrape each product in its own tab
//       for (const productUrl of productLinks) {
//         if (visited[productUrl]) {
//           continue; // already scraped in a prior run
//         }

//         // Retry a few times for product page
//         let productData = null;
//         for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
//           productData = await scrapeProduct(browser, productUrl);
//           if (productData && (productData.sku || productData.title)) break;
//           console.warn(`🔁 Retry ${attempt}/${MAX_RETRIES} for ${productUrl}`);
//           await delay(500 * attempt);
//         }

//         categoryCount++;
//         grandCount++;

//         if (productData) {
//           console.log(
//             `[${grandCount}] ✅ SKU: ${productData.sku || "(no-sku)"} | Price: ${productData.price || ""}`
//           );
//           scrapedData.push(productData);
//         } else {
//           console.log(`[${grandCount}] ❌ Failed: ${productUrl}`);
//         }

//         visited[productUrl] = true;

//         // Periodic flush
//         if (scrapedData.length % FLUSH_EVERY === 0) {
//           saveCheckpoint({ visited, data: scrapedData });
//           flushCSV(scrapedData);
//         }

//         await delay(jitter(PRODUCT_DELAY_MS));
//       }

//       // Next page?
//       const nextPage = await getPaginationNext(catPage);
//       if (nextPage) {
//         console.log(`➡️ Moving to next page: ${nextPage}`);
//         currentPage = nextPage;
//         await delay(jitter(CATEGORY_DELAY_MS));
//       } else {
//         currentPage = null;
//       }
//     }

//     console.log(`✅ Finished category: ${categoryUrl} | Total scraped here: ${categoryCount}`);
//   }

//   // Final save
//   saveCheckpoint({ visited, data: scrapedData });
//   flushCSV(scrapedData);

//   await browser.close();

//   // Summary
//   const unique = new Set(scrapedData.map((r) => (r.sku || "").trim())).size;
//   console.log(`\n🎯 TOTAL SKUs SCRAPED (unique): ${unique}`);
//   console.log(
//     `✅ Data saved to ${path.join(OUTPUT_DIR, CSV_FILE)} | Checkpoint: ${path.join(OUTPUT_DIR, CHECKPOINT_FILE)}`
//   );
// })();



// const puppeteer = require("puppeteer");
// const fs = require("fs");
// const { stringify } = require("csv-stringify/sync");

// const CATEGORY_URLS = [
//   "https://stingersolutions.com/collections/infotainment",
//   // "https://stingersolutions.com/collections/audio",
//   // "https://stingersolutions.com/collections/lighting",
//   // "https://stingersolutions.com/collections/remote-starters"
// ];

// async function delay(ms) {
//   return new Promise(res => setTimeout(res, ms));
// }

// async function safeGoto(page, url, retries = 3) {
//   for (let i = 0; i < retries; i++) {
//     try {
//       await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
//       return true;
//     } catch (err) {
//       console.warn(`⚠️ Timeout loading ${url} (retry ${i + 1}/${retries})`);
//       await delay(2000);
//     }
//   }
//   console.error(`❌ Failed to load ${url} after ${retries} retries`);
//   return false;
// }

// (async () => {
//   const browser = await puppeteer.launch({ headless: true });
//   const page = await browser.newPage();
//   const scrapedData = [];

//   for (const categoryUrl of CATEGORY_URLS) {
//     console.log(`\n🚀 Starting category: ${categoryUrl}`);
//     let currentPage = categoryUrl;
//     let categoryCount = 0;

//     while (currentPage) {
//       await safeGoto(page, currentPage);

//       await page.waitForSelector("a.product-item__title");
//       const productLinks = await page.$$eval(
//         "a.product-item__title.text--strong.link",
//         els => els.map(e => e.href)
//       );

//       console.log(`📄 Found ${productLinks.length} products on this page`);

//       for (let i = 0; i < productLinks.length; i++) {
//         const productUrl = productLinks[i];

//         if (!(await safeGoto(page, productUrl))) continue;

//         const productData = await page.evaluate(() => {
//           const title = document.querySelector("h1.product__title")?.innerText.trim() || "";
//           const sku = document.querySelector(".product-meta__sku-number")?.innerText.trim() || "";
//           const price = document.querySelector(".price span:not(.visually-hidden)")?.innerText.trim() || "";
//           return { title, sku, price, url: window.location.href };
//         });

//         categoryCount++;
//         console.log(`[${categoryCount}] ✅ SKU: ${productData.sku} | Price: ${productData.price}`);

//         scrapedData.push(productData);

//         await delay(1000); // 🟢 avoid hitting server too fast
//         await safeGoto(page, currentPage); // return back to category
//       }

//       // Handle pagination
//       const nextButton = await page.$("a.pagination__next.link");
//       if (nextButton) {
//         currentPage = await page.$eval("a.pagination__next.link", el => el.href);
//         console.log(`➡️ Moving to next page: ${currentPage}`);
//       } else {
//         currentPage = null;
//       }
//     }

//     console.log(`✅ Finished category: ${categoryUrl} | Total scraped here: ${categoryCount}`);
//   }

//   await browser.close();

//   const csv = stringify(scrapedData, { header: true });
//   fs.writeFileSync("stinger_products.csv", csv);

//   console.log(`\n🎯 TOTAL SKUs SCRAPED ACROSS ALL CATEGORIES: ${scrapedData.length}`);
//   console.log("✅ Data saved to stinger_products.csv");
// })();
