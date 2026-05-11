// // RESET: rm results.csv resume-progress.json failed-urls.txt


const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const prisma = require("../../../../lib/prisma");
const scrapePart = require("./partsengine-scraper");

puppeteer.use(StealthPlugin());

const BACKUP_EVERY = 50;
const SCRAPE_TIMEOUT_MS = 45000;
const URLS_FILE = "urls.txt";
const FAILED_FILE = "failed-urls.txt";
const RESUME_FILE = "resume-progress.json";
const OUTPUT_FILE = "results.csv";

let allResults = [];
let failed = [];
const errorCounts = new Map();

function recordError(errorMessage) {
  const normalizedMessage = errorMessage || "Unknown error";
  errorCounts.set(normalizedMessage, (errorCounts.get(normalizedMessage) || 0) + 1);
}

function loadResumeIndex() {
  if (fs.existsSync(RESUME_FILE)) {
    const saved = JSON.parse(fs.readFileSync(RESUME_FILE));
    return saved.lastIndex || 0;
  }
  return 0;
}

function saveProgress(index) {
  fs.writeFileSync(RESUME_FILE, JSON.stringify({ lastIndex: index }, null, 2));
}

async function loadUrlsFromDatabase() {
  const products = await prisma.product.findMany({
    where: {
      status: 1,
      price: {
        gt: 0,
      },
      searchable_sku: {
        not: null,
      },
      partsEngine_code: {
        not: null,
      },
      NOT: [
        {
          searchable_sku: {
            endsWith: "-",
          },
        },
        {
          partsEngine_code: "",
        },
      ],
    },
    select: {
      partsEngine_code: true,
    },
    orderBy: {
      sku: "asc",
    },
  });

  const urls = products
    .map((product) => product.partsEngine_code?.trim())
    .filter(Boolean);

  fs.writeFileSync(URLS_FILE, `${urls.join("\n")}${urls.length ? "\n" : ""}`);
  console.log(`🗂️ Loaded ${urls.length} PartsEngine URLs from Product and refreshed ${URLS_FILE}`);

  return urls;
}

function saveResultsCSV(results) {
  const csv = ["URL,SKU,Price", ...results.map(r => `${r.url},${r.sku},${r.price}`)].join("\n");
  fs.writeFileSync(OUTPUT_FILE, csv);
  console.log(`💾 Saved ${results.length} SKUs to ${OUTPUT_FILE}`);
}

function logFailed(url) {
  failed.push(url);
  fs.appendFileSync(FAILED_FILE, url + "\n");
}

function logErrorSummary() {
  if (errorCounts.size === 0) {
    console.log("📉 Error summary: no errors recorded");
    return;
  }

  console.log("📉 Error summary:");

  for (const [message, count] of Array.from(errorCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${count}x ${message}`);
  }
}
const RESTART_EVERY = 20;
let browser;
let browserCloseExpected = false;

function shouldRunHeadless() {
  const value = process.env.PARTSENGINE_HEADLESS;

  if (value === undefined) {
    return true;
  }

  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

async function launchBrowser() {
  browser = await puppeteer.launch({
    headless: shouldRunHeadless() ? "new" : false,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  browser.on("disconnected", () => {
    if (!browserCloseExpected) {
      console.warn("⚠️ Browser disconnected unexpectedly");
    }
  });

  return browser;
}

async function createPage() {
  const nextPage = await browser.newPage();

  nextPage.setDefaultNavigationTimeout(SCRAPE_TIMEOUT_MS);
  nextPage.setDefaultTimeout(SCRAPE_TIMEOUT_MS);
  await nextPage.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  return nextPage;
}

async function closePage(pageToClose) {
  if (!pageToClose || pageToClose.isClosed()) {
    return;
  }

  try {
    await pageToClose.close();
  } catch (error) {
    console.warn(`⚠️ Failed to close page cleanly: ${error.message}`);
  }
}

async function restartBrowser(reason) {
  browserCloseExpected = true;
  await browser?.close().catch(() => {});
  browserCloseExpected = false;
  console.log(`🔁 Restarting browser${reason ? `: ${reason}` : ""}...`);
  await launchBrowser();
}

async function scrapeWithTimeout(page, url) {
  let timeoutId;

  const timer = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Scrape timeout after ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([scrapePart(page, url), timer]);
  } finally {
    clearTimeout(timeoutId);
  }
}

(async () => {
  const startTime = Date.now();
  const urls = await loadUrlsFromDatabase();
  const start = loadResumeIndex();

  console.log(`▶️ Starting PartsEngine scrape for ${urls.length} URLs`);

  await launchBrowser();

  for (let i = start; i < urls.length; i++) {
    const url = urls[i];
    let page;
    const itemStart = Date.now();

    try {
      console.log(`🔍 [${i + 1}/${urls.length}] ${url}`);

      page = await createPage();

      let data;
      try {
        data = { ...(await scrapeWithTimeout(page, url)), url };
      } catch (err) {
        if (err.message.includes("Redirected to search page")) {
          console.warn(`↪️ Redirected to search page for ${url}`);
          recordError("Redirected to search page");
          data = {
            sku: "N/A",
            price: "N/A",
            title: "Redirected to Search Page",
            url,
          };
        } else if (err.message.includes("Waiting for selector")) {
          console.warn(`❌ Page not found for ${url}`);
          recordError("Page not found");
          data = {
            sku: "N/A",
            price: "N/A",
            title: "Page Not Found",
            url,
          };
        } else {
          throw err;
        }
      }

      console.log(`🧾 SKU: ${data.sku} | Price: $${data.price}`);
      console.log(`⏱️ ${Date.now() - itemStart}ms`);
      allResults.push(data);
    } catch (err) {
      console.warn(`❌ Failed: ${url} — ${err.message}`);
      recordError(err.message);
      logFailed(url);

      if (
        err.message.includes("Scrape timeout") ||
        err.message.includes("Target closed") ||
        err.message.includes("Session closed")
      ) {
        await restartBrowser(`after failure on SKU #${i + 1}`);
      }
    } finally {
      await closePage(page);
    }

    if ((i + 1) % BACKUP_EVERY === 0) {
      saveProgress(i + 1);
      saveResultsCSV(allResults);
    }

    if ((i + 1) % RESTART_EVERY === 0) {
      await restartBrowser(`at SKU #${i + 1}`);
    }

    // await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    await new Promise((r) => setTimeout(r, 250)); // 0.25 seconds delay

  }

  browserCloseExpected = true;
  await browser.close();

  saveProgress(urls.length);
  saveResultsCSV(allResults);

  const totalTime = (Date.now() - startTime) / 1000;
  const minutes = Math.floor(totalTime / 60);
  const seconds = Math.floor(totalTime % 60);
  console.log(`✅ All SKUs processed.`);
  console.log(`📊 Scraped ${allResults.length} of ${urls.length} URLs`);
  logErrorSummary();
  console.log(`🕒 Total time: ${minutes} min ${seconds} sec`);
})()
  .catch((err) => {
    console.error(`❌ PartsEngine batch runner failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });




// const fs = require("fs");
// const path = require("path");
// const puppeteer = require("puppeteer-core");

// const BACKUP_EVERY = 50;
// const URLS_FILE = "urls-1.txt";
// const FAILED_FILE = "failed-urls.txt";
// const RESUME_FILE = "resume-progress.json";
// const OUTPUT_FILE = "results.csv";

// let allResults = [];
// let failed = [];

// function loadResumeIndex() {
//   if (fs.existsSync(RESUME_FILE)) {
//     const saved = JSON.parse(fs.readFileSync(RESUME_FILE));
//     return saved.lastIndex || 0;
//   }
//   return 0;
// }

// function saveProgress(index) {
//   fs.writeFileSync(RESUME_FILE, JSON.stringify({ lastIndex: index }, null, 2));
// }

// function saveResultsCSV(results) {
//   const csv = ["URL,SKU,Price", ...results.map(r => `${r.url},${r.sku},${r.price}`)].join("\n");
//   fs.writeFileSync(OUTPUT_FILE, csv);
//   console.log(`💾 Saved ${results.length} SKUs to ${OUTPUT_FILE}`);
// }

// function logFailed(url) {
//   failed.push(url);
//   fs.appendFileSync(FAILED_FILE, url + "\n");
// }

// const startTime = Date.now();

// (async () => {
//   const urls = fs.readFileSync(URLS_FILE, "utf-8").split("\n").map(u => u.trim()).filter(Boolean);
//   let start = loadResumeIndex();

//   console.log(`▶️ Resuming from index ${start} of ${urls.length}`);

//   const browser = await puppeteer.launch({
//     headless: false,
//     executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
//     args: ["--no-sandbox", "--disable-setuid-sandbox"]
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

//   for (let i = start; i < urls.length; i++) {
//     const url = urls[i];

//     try {
//       console.log(`🔍 [${i + 1}/${urls.length}] ${url}`);
//       console.log(`🧾 SKU: ${data.sku} | Price: $${data.price}`);
//       allResults.push(data);
//     } catch (err) {
//       console.warn(`❌ Failed: ${url} — ${err.message}`);
//       logFailed(url);
//     }

//     if ((i + 1) % BACKUP_EVERY === 0) {
//       saveProgress(i + 1);
//       saveResultsCSV(allResults);
//     }

//     await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000)); // 3–5s delay
//   }

//   await browser.close();

//   saveProgress(urls.length);
//   saveResultsCSV(allResults);
//   const totalTime = (Date.now() - startTime) / 1000;
//   const minutes = Math.floor(totalTime / 60);
//   const seconds = Math.floor(totalTime % 60);
//   console.log(`✅ All SKUs processed.`);
//   console.log(`🕒 Total time: ${minutes} min ${seconds} sec`);
// })();

// **********

// const fs = require("fs");
// const path = require("path");
// const puppeteer = require("puppeteer-core");
// const scrapePart = require("./partsengine-scraper");

// const BACKUP_EVERY = 50;
// const URLS_FILE = "urls-2.txt";
// const FAILED_FILE = "failed-urls.txt";
// const RESUME_FILE = "resume-progress.json";
// const OUTPUT_FILE = "results.csv";

// let allResults = [];
// let failed = [];

// function loadResumeIndex() {
//   if (fs.existsSync(RESUME_FILE)) {
//     const saved = JSON.parse(fs.readFileSync(RESUME_FILE));
//     return saved.lastIndex || 0;
//   }
//   return 0;
// }

// function saveProgress(index) {
//   fs.writeFileSync(RESUME_FILE, JSON.stringify({ lastIndex: index }, null, 2));
// }

// function saveResultsCSV(results) {
//   const csv = ["URL,SKU,Price", ...results.map(r => `${r.url},${r.sku},${r.price}`)].join("\n");
//   fs.writeFileSync(OUTPUT_FILE, csv);
//   console.log(`💾 Saved ${results.length} SKUs to ${OUTPUT_FILE}`);
// }

// function logFailed(url) {
//   failed.push(url);
//   fs.appendFileSync(FAILED_FILE, url + "\n");
// }


// const RESTART_EVERY = 75;
// let browser, page;

// async function launchBrowser() {
//   browser = await puppeteer.launch({
//     headless: false,
//     executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });

//   page = await browser.newPage();
//   await page.setUserAgent(
//     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
//   );
// }

// (async () => {
//   const startTime = Date.now();
//   const urls = fs.readFileSync(URLS_FILE, "utf8").split("\n").filter(Boolean);
//   const start = loadResumeIndex();

//   await launchBrowser();

//   for (let i = start; i < urls.length; i++) {
//     const url = urls[i];

//     try {
//       console.log(`🔍 [${i + 1}/${urls.length}] ${url}`);
//       const data = { ...(await scrapePart(page, url)), url };
//       console.log(`🧾 SKU: ${data.sku} | Price: $${data.price}`);
//       allResults.push(data);
//     } catch (err) {
//       console.warn(`❌ Failed: ${url} — ${err.message}`);
//       logFailed(url);
//     }

//     if ((i + 1) % BACKUP_EVERY === 0) {
//       saveProgress(i + 1);
//       saveResultsCSV(allResults);
//     }

//     if ((i + 1) % RESTART_EVERY === 0) {
//       await browser.close();
//       console.log(`🔁 Restarting browser at SKU #${i + 1}...`);
//       await launchBrowser();
//     }

//     await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
//   }

//   await browser.close();

//   saveProgress(urls.length);
//   saveResultsCSV(allResults);

//   const totalTime = (Date.now() - startTime) / 1000;
//   const minutes = Math.floor(totalTime / 60);
//   const seconds = Math.floor(totalTime % 60);
//   console.log(`✅ All SKUs processed.`);
//   console.log(`🕒 Total time: ${minutes} min ${seconds} sec`);
// })();



