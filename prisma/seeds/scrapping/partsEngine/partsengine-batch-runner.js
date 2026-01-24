// // RESET: rm results.csv resume-progress.json failed-urls.txt

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const scrapePart = require("./partsengine-scraper");
const logger = require("../../../../utils/logger");

const SCRIPT_NAME = "partsengine-batch-runner";
const BACKUP_EVERY = 50;
const URLS_FILE = "urls.txt";
const FAILED_FILE = "failed-urls.txt";
const RESUME_FILE = "resume-progress.json";
const OUTPUT_FILE = "results.csv";

let allResults = [];
let failed = [];

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

function saveResultsCSV(results) {
  const csv = ["URL,SKU,Price", ...results.map(r => `${r.url},${r.sku},${r.price}`)].join("\n");
  fs.writeFileSync(OUTPUT_FILE, csv);
  console.log(`💾 Saved ${results.length} SKUs to ${OUTPUT_FILE}`);
}

function logFailed(url) {
  failed.push(url);
  fs.appendFileSync(FAILED_FILE, url + "\n");
}


const RESTART_EVERY = 20;
let browser, page;

async function launchBrowser() {
  browser = await puppeteer.launch({
    headless: false,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
}

(async () => {
  const startTime = Date.now();
  const urls = fs.readFileSync(URLS_FILE, "utf8").split("\n").filter(Boolean);
  const start = loadResumeIndex();

  logger.info("Scraping started", {
    script: SCRIPT_NAME,
    totalUrls: urls.length,
    resumeIndex: start,
    urlsFile: URLS_FILE
  });

  await launchBrowser();

  for (let i = start; i < urls.length; i++) {
    const url = urls[i];

    try {
      console.log(`🔍 [${i + 1}/${urls.length}] ${url}`);
      
let data;
try {
  data = { ...(await scrapePart(page, url)), url };
} catch (err) {
  if (err.message.includes("Waiting for selector")) {
    console.warn(`❌ Page not found for ${url}`);
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
      allResults.push(data);
    } catch (err) {
      console.warn(`❌ Failed: ${url} — ${err.message}`);
      logFailed(url);
      logger.warn("URL scrape failed", {
        script: SCRIPT_NAME,
        url,
        error: err.message,
        progress: `${i + 1}/${urls.length}`
      });
    }

    if ((i + 1) % BACKUP_EVERY === 0) {
      saveProgress(i + 1);
      saveResultsCSV(allResults);
    }

    if ((i + 1) % RESTART_EVERY === 0) {
      await browser.close();
      console.log(`🔁 Restarting browser at SKU #${i + 1}...`);
      await launchBrowser();
    }

    // await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    await new Promise((r) => setTimeout(r, 250)); // 0.25 seconds delay

  }

  await browser.close();

  saveProgress(urls.length);
  saveResultsCSV(allResults);

  const totalTime = (Date.now() - startTime) / 1000;
  const minutes = Math.floor(totalTime / 60);
  const seconds = Math.floor(totalTime % 60);
  console.log(`✅ All SKUs processed.`);
  console.log(`🕒 Total time: ${minutes} min ${seconds} sec`);

  logger.info("Scraping completed", {
    script: SCRIPT_NAME,
    totalUrls: urls.length,
    successfulScrapes: allResults.length,
    failedScrapes: failed.length,
    duration: `${minutes}m ${seconds}s`,
    outputFile: OUTPUT_FILE
  });
})();




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



