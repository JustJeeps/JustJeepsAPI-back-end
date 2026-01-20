const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { spawn } = require('child_process');

const BASE_URL = 'https://jobber.metalcloak.com';
const LOGIN_URL = `${BASE_URL}/customer/account/login`;

// Organized categories for better tracking
const CATEGORY_CONFIG = {
  jeep: [
    { path: "/jeep-jt-gladiator-parts-accessories.html", name: "JT Gladiator" },
    { path: "/jeep-jl-wrangler-parts-accessories.html", name: "JL Wrangler" },
    { path: "/jeep-jk-wrangler-parts-accessories.html", name: "JK Wrangler" },
    { path: "/jeep-tj-lj-wrangler-parts-accessories.html", name: "TJ/LJ Wrangler" },
    { path: "/jeep-yj-wrangler-parts-accessories.html", name: "YJ Wrangler" },
    { path: "/jeep-cj5-cj7-cj8-parts-accessories.html", name: "CJ5/CJ7/CJ8" }
  ],
  other_vehicles: [
    { path: "/ford-bronco-6g.html", name: "Ford Bronco 6G" },
    { path: "/toyota-suspension-accessories.html", name: "Toyota" },
    { path: "/dodge-ram-suspension-lift-kits.html", name: "Dodge Ram" },
    { path: "/ineos-grenadier-products.html", name: "Ineos Grenadier" }
  ],
  products: [
    { path: "/metalcloak-adventure-rack-systems.html", name: "Adventure Rack Systems" },
    { path: "/builder-parts.html", name: "Builder Parts" },
    { path: "/tools-accessories.html", name: "Tools & Accessories" },
    { path: "/rocksport-shocks.html", name: "RockSport Shocks" },
    { path: "/shock-absorbers.html", name: "Shock Absorbers" },
    { path: "/carbon-axles.html", name: "Carbon Axles" },
    { path: "/new-metalcloak-products.html", name: "New Products" }
  ]
};

/**
 * Semi-Automated MetalCloak Price Scraper
 * 
 * This script handles the CAPTCHA limitation by:
 * 1. Opening browser for manual login
 * 2. Waiting for user confirmation
 * 3. Automating all data extraction
 * 4. Generating CSV and JSON for database integration
 */
async function scrapeMetalCloakPrices() {
  console.log('🤖 MetalCloak Semi-Automated Price Scraper');
  console.log('🚫 Due to CAPTCHA protection, manual login is required\n');

  const browser = await puppeteer.launch({ 
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });
  
  const page = await browser.newPage();
  
  try {
    // Navigate to login page
    console.log('🌐 Opening MetalCloak login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Manual login step
    console.log('\n🔐 MANUAL STEP REQUIRED:');
    console.log('   1. Enter your username and password');
    console.log('   2. Complete the CAPTCHA');
    console.log('   3. Click login');
    console.log('   4. Wait for dashboard to load (you should see orange buttons)');
    console.log('   5. Press ENTER in this terminal to continue...\n');
    
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        console.log('✅ Continuing with automated scraping...\n');
        resolve();
      });
    });

    // Verify login success
    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      console.log('❌ Still on login page. Please ensure you are logged in and try again.');
      await browser.close();
      return;
    }

    console.log('✅ Login verified, starting data extraction...\n');

    const allData = [];
    const scrapingStats = {
      startTime: new Date().toISOString(),
      categoriesProcessed: 0,
      productsFound: 0,
      errors: []
    };

    // Process all categories
    const allCategories = [
      ...CATEGORY_CONFIG.jeep,
      ...CATEGORY_CONFIG.other_vehicles,
      ...CATEGORY_CONFIG.products
    ];

    for (const category of allCategories) {
      const categoryUrl = `${BASE_URL}${category.path}`;
      console.log(`🔍 Scraping: ${category.name}`);
      console.log(`   URL: ${categoryUrl}`);

      try {
        await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for products to load
        await page.waitForSelector('div.product.details.product-item-details', { timeout: 10000 });

        const products = await page.$$eval(
          'div.product.details.product-item-details',
          (items, categoryName) => {
            return items.map(item => {
              const title = item.querySelector('a.product-item-link')?.innerText.trim() || '';
              const productCode = item.querySelector('.productSku')?.innerText.replace('Product Code:', '').trim() || '';
              const productUrl = item.querySelector('a.product-item-link')?.href || '';

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

              // Additional fallback for MAP price
              if (!mapPrice) {
                const fallbackMap = item.querySelector('[id^="old-price"] .price')?.innerText.trim();
                mapPrice = fallbackMap || '';
              }

              // Clean up prices - remove $ and convert to numbers
              const cleanPrice = (priceStr) => {
                if (!priceStr) return null;
                const cleaned = priceStr.replace(/[$,]/g, '').trim();
                const parsed = parseFloat(cleaned);
                return isNaN(parsed) ? null : parsed;
              };

              return {
                title,
                productCode,
                category: categoryName,
                mapPrice: mapPrice,
                mapPriceNumeric: cleanPrice(mapPrice),
                yourPrice: yourPrice,
                yourPriceNumeric: cleanPrice(yourPrice),
                productUrl,
                scrapedAt: new Date().toISOString()
              };
            });
          },
          category.name
        );

        console.log(`   ✅ Found ${products.length} products`);
        allData.push(...products);
        scrapingStats.productsFound += products.length;
        scrapingStats.categoriesProcessed++;

        // Rate limiting - be nice to their server
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        console.log(`   ❌ Error scraping ${category.name}: ${error.message}`);
        scrapingStats.errors.push({
          category: category.name,
          error: error.message
        });
      }
    }

    scrapingStats.endTime = new Date().toISOString();
    console.log('\n📊 Scraping Summary:');
    console.log(`   Categories processed: ${scrapingStats.categoriesProcessed}/${allCategories.length}`);
    console.log(`   Total products found: ${scrapingStats.productsFound}`);
    console.log(`   Errors: ${scrapingStats.errors.length}`);

    if (scrapingStats.errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      scrapingStats.errors.forEach(err => {
        console.log(`   ${err.category}: ${err.error}`);
      });
    }

    // Save data in multiple formats
    const timestamp = new Date().toISOString().split('T')[0];
    const outputDir = path.join(__dirname, 'output');
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // CSV for spreadsheet analysis
    const csv = stringify(allData, {
      header: true,
      columns: ['title', 'productCode', 'category', 'mapPrice', 'yourPrice', 'mapPriceNumeric', 'yourPriceNumeric', 'productUrl', 'scrapedAt']
    });
    const csvPath = path.join(outputDir, `metalcloak-pricing-${timestamp}.csv`);
    fs.writeFileSync(csvPath, csv);

    // JSON for database integration
    const jsonData = {
      metadata: {
        ...scrapingStats,
        totalProducts: allData.length,
        vendor: 'MetalCloak',
        website: 'https://jobber.metalcloak.com',
        dataFormat: 'pricing-catalog'
      },
      products: allData
    };
    const jsonPath = path.join(outputDir, `metalcloak-data-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));

    // Summary report
    const summaryPath = path.join(outputDir, `metalcloak-summary-${timestamp}.txt`);
    const summary = `
MetalCloak Scraping Summary
Generated: ${new Date().toISOString()}

STATISTICS:
- Total Products: ${allData.length}
- Categories Processed: ${scrapingStats.categoriesProcessed}/${allCategories.length}
- Errors: ${scrapingStats.errors.length}

PRICE ANALYSIS:
- Products with MAP Price: ${allData.filter(p => p.mapPriceNumeric).length}
- Products with Your Price: ${allData.filter(p => p.yourPriceNumeric).length}
- Average MAP Price: $${(allData.filter(p => p.mapPriceNumeric).reduce((sum, p) => sum + p.mapPriceNumeric, 0) / allData.filter(p => p.mapPriceNumeric).length || 0).toFixed(2)}
- Average Your Price: $${(allData.filter(p => p.yourPriceNumeric).reduce((sum, p) => sum + p.yourPriceNumeric, 0) / allData.filter(p => p.yourPriceNumeric).length || 0).toFixed(2)}

FILES GENERATED:
- CSV: ${csvPath}
- JSON: ${jsonPath}
- Summary: ${summaryPath}

NEXT STEPS:
1. Review the CSV file for data quality
2. Use JSON file for database integration
3. Map MetalCloak product codes to your SKUs
4. Set up semi-automated update schedule
`;

    fs.writeFileSync(summaryPath, summary);

    console.log('\n✅ Scraping completed successfully!');
    console.log(`\n📁 Files saved in: ${outputDir}`);
    console.log(`   📄 CSV: metalcloak-pricing-${timestamp}.csv`);
    console.log(`   📄 JSON: metalcloak-data-${timestamp}.json`);
    console.log(`   📄 Summary: metalcloak-summary-${timestamp}.txt`);

    console.log('\n💡 Automation Strategy for MetalCloak:');
    console.log('   🚫 Fully automated: Not possible (CAPTCHA)');
    console.log('   ✅ Semi-automated: Manual login + automated scraping');
    console.log('   📅 Recommended frequency: Weekly/Bi-weekly');
    console.log('   🔄 Update process: Run this script manually when needed');

    // Return the path to the JSON file for integration
    return jsonPath;

  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * Run MetalCloak integration after scraping
 */
async function runIntegration() {
  return new Promise((resolve, reject) => {
    console.log('\n🔄 Starting automatic database integration...');
    
    const integrationScript = path.join(__dirname, '../../metalcloak-integration.js');
    const childProcess = spawn('node', [integrationScript], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '../../../')
    });

    childProcess.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ Database integration completed successfully!');
        resolve();
      } else {
        console.error(`\n❌ Database integration failed with exit code ${code}`);
        reject(new Error(`Integration process exited with code ${code}`));
      }
    });

    childProcess.on('error', (error) => {
      console.error('\n❌ Error running integration:', error.message);
      reject(error);
    });
  });
}

/**
 * Main function that combines scraping and integration
 */
async function scrapeAndSeed() {
  try {
    console.log('🚀 MetalCloak Scrape & Seed Pipeline');
    console.log('=====================================\n');

    // Step 1: Scrape MetalCloak data
    const jsonPath = await scrapeMetalCloakPrices();
    
    if (!jsonPath) {
      console.error('❌ Scraping failed, skipping integration');
      return;
    }

    // Step 2: Wait a moment before integration
    console.log('\n⏳ Waiting 3 seconds before starting integration...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Run integration
    await runIntegration();

    console.log('\n🎉 Complete! MetalCloak data has been scraped and seeded to database.');
    console.log('💡 You can now run: npm run magento-attributes-metalcloak');

  } catch (error) {
    console.error('❌ Pipeline failed:', error.message);
  }
}

// Run the scraper and integration pipeline
scrapeAndSeed().catch(console.error);