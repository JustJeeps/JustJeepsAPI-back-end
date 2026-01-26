const puppeteer = require('puppeteer');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

const BASE_URL = 'https://jobber.metalcloak.com';
const LOGIN_URL = `${BASE_URL}/customer/account/login`;
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
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

  console.log('\n🔐 Please manually log in and solve CAPTCHA.');
  console.log('📌 Once you see the orange buttons (dashboard), press ENTER in this terminal...\n');
  await new Promise(resolve => process.stdin.once('data', resolve));

  const allData = [];

  for (const path of CATEGORY_PATHS) {
    const categoryUrl = `${BASE_URL}${path}`;
    console.log(`🔍 Scraping: ${categoryUrl}`);
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







    allData.push(...products);
  }

const csv = stringify(allData, {
  header: true,
  columns: ['title', 'productCode', 'mapPrice', 'yourPrice']
});

  fs.writeFileSync('metalcloak-pricing.csv', csv);
  console.log('\n✅ Done! Data saved to: metalcloak-products.csv');

  await browser.close();
})();


