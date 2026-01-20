//PRODUCTS DETAILS
// scrape-stinger-products.js
// Usage: node scrape-stinger-products.js [inputFile] [outputFile]
//
// Reads URLs from stinger_urls.txt (one per line) and outputs stinger_product_details.csv
// Columns: url, sku, title, price_raw, price_number, image_all_json

const fs = require("fs");
const readline = require("readline");
const { stringify } = require("csv-stringify/sync");
const puppeteer = require("puppeteer");

const INPUT_FILE = process.argv[2] || "stinger_urls.txt";
const OUTPUT_FILE = process.argv[3] || "stinger_product_details.csv";
const FAILED_FILE = "failed_urls.txt";

const NAV_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JITTER = (min, max) => min + Math.random() * (max - min);

function ensureFile(filePath, headerLine) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, headerLine, "utf8");
  }
}

async function readUrls(file) {
  if (!fs.existsSync(file)) {
    console.error(`Input file not found: ${file}`);
    process.exit(1);
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  const urls = [];
  for await (const line of rl) {
    const t = line.trim();
    if (t && !t.startsWith("#")) urls.push(t);
  }
  return Array.from(new Set(urls)); // de-duplicate
}

function normUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return "https://stingersolutions.com" + u;
  return u;
}

async function scrapeOne(page, url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });

  // Ensure core bits are present (best-effort)
  await page
    .waitForSelector(
      "h1.product-meta__title, .product-meta__title, .product-meta__sku-number",
      { timeout: 20000 }
    )
    .catch(() => {});
  // Try to wait for gallery links, but don't fail if missing
  await page
    .waitForSelector(".product-gallery__thumbnail-list a", { timeout: 4000 })
    .catch(() => {});
  // Small pause to let Shogun/shopify hydrate
  await sleep(500);

  const data = await page.evaluate(() => {
    const normUrl = (u) => {
      if (!u) return "";
      if (u.startsWith("//")) return "https:" + u;
      if (u.startsWith("/")) return location.origin + u;
      return u;
    };

    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : "";
    };

    const title =
      text("h1.product-meta__title") ||
      text("h1.product-meta__title.heading.h1") ||
      (document
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content") || "").trim();

    const sku =
      text(".product-meta__sku-number") ||
      text('[itemprop="sku"]') ||
      text(".product__sku") ||
      text(".sku") ||
      "";

    // Keep price "as-is" from the container; you can polish later if you want
    const priceHost =
      document.querySelector(".price") ||
      document.querySelector(".product__price") ||
      document.querySelector(".price__current") ||
      document.querySelector(".price-item--sale") ||
      document.querySelector(".price-item--regular");

    const price_raw = priceHost
      ? priceHost.textContent.replace(/\s+/g, " ").trim()
      : "";

    // basic numeric extraction (kept simple)
    const m = price_raw.match(/\d[\d,]*(?:\.\d{2})?/);
    const price_number = m ? m[0].replace(/,/g, "") : "";

    // --- IMAGES: anchors inside the thumbnail list
    const anchors = Array.from(
      document.querySelectorAll(".product-gallery__thumbnail-list a")
    );
    const images = anchors
      .map((a) => a.getAttribute("href") || a.getAttribute("data-href") || "")
      .map((u) => normUrl(u))
      .filter(Boolean);

    // De-dupe while preserving order
    const seen = new Set();
    const image_all = [];
    for (const u of images) {
      if (!seen.has(u)) {
        seen.add(u);
        image_all.push(u);
      }
    }

    return {
      title,
      sku,
      price_raw,
      price_number,
      image_all_json: JSON.stringify(image_all),
    };
  });

  return { url, ...data };
}

async function main() {
  const urls = await readUrls(INPUT_FILE);
  console.log(`Found ${urls.length} URLs to scrape from ${INPUT_FILE}`);

  ensureFile(
    OUTPUT_FILE,
    stringify([["url", "sku", "title", "price_raw", "price_number", "image_all_json"]])
  );
  ensureFile(FAILED_FILE, "");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 900 });

  const outRows = [];
  const failed = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let attempt = 0;
    let success = false;

    while (attempt < MAX_RETRIES && !success) {
      attempt++;
      try {
        console.log(`[${i + 1}/${urls.length}] ${url} (try ${attempt})`);
        const row = await scrapeOne(page, url);
        if (!row.title && !row.sku) throw new Error("Missing title and SKU");
        outRows.push([
          row.url,
          row.sku,
          row.title,
          row.price_raw,
          row.price_number,
          row.image_all_json,
        ]);
        success = true;
      } catch (err) {
        console.warn(`  -> Error: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await sleep(JITTER(1200, 2500));
        }
      }
    }

    if (!success) {
      failed.push(url);
      fs.appendFileSync(FAILED_FILE, url + "\n", "utf8");
    }

    // Polite pacing
    await sleep(JITTER(600, 1200));

    // Flush periodically
    if (outRows.length >= 25 || i === urls.length - 1) {
      const csv = stringify(outRows);
      fs.appendFileSync(OUTPUT_FILE, csv, "utf8");
      outRows.length = 0;
    }
  }

  await browser.close();

  console.log(`\nDone. Results → ${OUTPUT_FILE}`);
  if (failed.length) {
    console.log(`Failed (${failed.length}) → ${FAILED_FILE}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
