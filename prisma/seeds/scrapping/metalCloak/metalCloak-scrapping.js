const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const logger = require('../../../../utils/logger');

const SCRIPT_NAME = 'metalCloak-scrapping';
const BASE_URL = 'https://jobber.metalcloak.com';
const LOGIN_URL = `${BASE_URL}/customer/account/login`;
const COOKIES_FILE = path.join(__dirname, 'metalcloak-cookies.json');
const CATEGORY_PATHS = [
  "/ford-bronco-6g.html",
  "/jeep-jt-gladiator-parts-accessories.html",
  "/jeep-jl-wrangler-parts-accessories.html",
  "/jeep-jk-wrangler-parts-accessories.html",
  "/jeep-tj-lj-wrangler-parts-accessories.html",
  "/jeep-yj-wrangler-parts-accessories.html",
  "/jeep-cj5-cj7-cj8-parts-accessories.html",
  "/metalcloak-adventure-rack-systems.html",
  "/builder-parts.html",
  "/tools-accessories.html",
  "/rocksport-shocks.html",
  "/toyota-suspension-accessories.html",
  "/dodge-ram-suspension-lift-kits.html",
  "/new-metalcloak-products.html",
  "/carbon-axles.html",
  "/ineos-grenadier-products.html",
  "/shock-absorbers.html"
];

(async () => {
  const startTime = Date.now();
  logger.info('Scraping started', {
    script: SCRIPT_NAME,
    categories: CATEGORY_PATHS.length,
    baseUrl: BASE_URL
  });

  let browser;
  try {
    browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    // Try to load saved cookies
    let loggedIn = false;
    if (fs.existsSync(COOKIES_FILE)) {
      console.log('🍪 Found saved cookies, attempting to restore session...');
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      await page.setCookie(...cookies);

      // Verify if session is still valid
      await page.goto(BASE_URL + '/customer/account', { waitUntil: 'networkidle2' });
      const isLoggedIn = await page.evaluate(() => {
        // Check if we're on the account page (not redirected to login)
        return !window.location.href.includes('/login');
      });

      if (isLoggedIn) {
        console.log('✅ Session restored successfully!');
        loggedIn = true;
        logger.info('Session restored from cookies', { script: SCRIPT_NAME });
      } else {
        console.log('⚠️ Saved cookies expired, need to login again...');
        fs.unlinkSync(COOKIES_FILE);
      }
    }

    // Manual login if not logged in
    if (!loggedIn) {
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

      console.log('\n🔐 Please manually log in and solve CAPTCHA.');
      console.log('📌 Once you see the orange buttons (dashboard), press ENTER in this terminal...\n');
      await new Promise(resolve => process.stdin.once('data', resolve));

      // Save cookies for next time
      const cookies = await page.cookies();
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      console.log('🍪 Cookies saved for future sessions!');
      logger.info('Login completed, cookies saved', { script: SCRIPT_NAME });
    }

    logger.info('Authentication successful', { script: SCRIPT_NAME });

    const allData = [];
    let categoryIndex = 0;

    for (const path of CATEGORY_PATHS) {
      categoryIndex++;
      const categoryUrl = `${BASE_URL}${path}`;
      console.log(`🔍 Scraping: ${categoryUrl}`);
      logger.info('Scraping category', {
        script: SCRIPT_NAME,
        category: path,
        progress: `${categoryIndex}/${CATEGORY_PATHS.length}`
      });

      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' });

      const products = await page.$$eval(
        'div.product.details.product-item-details',
        items =>
          items.map(item => {
            const title = item.querySelector('a.product-item-link')?.innerText.trim() || '';
            const productCode = item.querySelector('.productSku')?.innerText.replace('Product Code:', '').trim() || '';

            let yourPrice = item.querySelector('.special-price-simple .price')?.innerText.trim() || '';
            let mapPrice = '';

            const priceContainers = item.querySelectorAll('.price-container.price-final_price');
            priceContainers.forEach(container => {
              const label = container.querySelector('.price-label')?.innerText.trim().toLowerCase();
              const price = container.querySelector('.price')?.innerText.trim();

              if (label?.startsWith('map price')) {
                mapPrice = price || mapPrice;
              } else if (label?.startsWith('from') || label?.startsWith('your price')) {
                yourPrice = price || yourPrice;
              }
            });

            // Additional fallback if still no mapPrice and element exists with id^="old-price"
            if (!mapPrice) {
              const fallbackMap = item.querySelector('[id^="old-price"] .price')?.innerText.trim();
              mapPrice = fallbackMap || mapPrice;
            }

            return {
              title,
              productCode,
              mapPrice,
              yourPrice,
            };
          })
      );

      logger.info('Category scraped', {
        script: SCRIPT_NAME,
        category: path,
        productsFound: products.length
      });




      allData.push(...products);
    }

    const csv = stringify(allData, {
      header: true,
      columns: ['title', 'productCode', 'mapPrice', 'yourPrice']
    });

    fs.writeFileSync('metalcloak-pricing.csv', csv);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n✅ Done! Data saved to: metalcloak-pricing.csv');

    logger.info('Scraping completed', {
      script: SCRIPT_NAME,
      totalProducts: allData.length,
      categoriesScraped: CATEGORY_PATHS.length,
      duration: `${duration}s`,
      outputFile: 'metalcloak-pricing.csv'
    });

    await browser.close();
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('\n❌ Error:', error.message);

    logger.error('Scraping failed', {
      script: SCRIPT_NAME,
      error: error.message,
      stack: error.stack,
      duration: `${duration}s`
    });

    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
})();


