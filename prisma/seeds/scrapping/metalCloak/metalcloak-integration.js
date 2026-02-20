const MetalCloakService = require('../../../../services/metalcloak');
const path = require('path');
const fs = require('fs');

/**
 * MetalCloak Integration Runner
 * 
 * This script processes scraped MetalCloak data and integrates it into the database.
 * Run this after using the MetalCloak scraper to get the latest pricing data.
 */
async function runMetalCloakIntegration(filePathArg) {
  console.log('🤖 MetalCloak Database Integration');
  console.log('📋 Processing scraped data files...\n');

  const metalcloak = new MetalCloakService();

  try {
    // Look for the latest scraped data file
    const outputDir = path.join(__dirname, 'output');
    
    let filePath = filePathArg;

    if (!filePath) {
      if (!fs.existsSync(outputDir)) {
        console.log('❌ No output directory found. Please run the MetalCloak scraper first.');
        console.log(`   Expected directory: ${outputDir}`);
        return;
      }

    // Find the latest JSON file
      const files = fs.readdirSync(outputDir)
        .filter(file => file.startsWith('metalcloak-data-') && file.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length === 0) {
        console.log('❌ No MetalCloak data files found.');
        console.log('   Please run the MetalCloak scraper first to generate data files.');
        return;
      }

      const latestFile = files[0];
      filePath = path.join(outputDir, latestFile);
      
      console.log(`📄 Processing latest file: ${latestFile}`);
      console.log(`   Path: ${filePath}\n`);
    } else {
      console.log('📄 Processing provided file path');
      console.log(`   Path: ${filePath}\n`);
    }

    // Process the data
    const results = await metalcloak.processScrapedData(filePath);

    // Display results
    console.log('\n📊 Integration Results:');
    console.log(`   Total processed: ${results.totalProcessed}`);
    console.log(`   Errors: ${results.errors.length}`);

    if (results.errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      results.errors.slice(0, 10).forEach(error => {
        console.log(`   ${error.productCode}: ${error.error}`);
      });
      
      if (results.errors.length > 10) {
        console.log(`   ... and ${results.errors.length - 10} more errors`);
      }
    }

    // Get updated statistics
    console.log('\n📈 MetalCloak Statistics:');
    const stats = await metalcloak.getMetalCloakStats();
    console.log(`   Products in database: ${stats.totalProducts}`);
    console.log(`   With pricing: ${stats.withPricing}`);
    console.log(`   Average price: $${stats.averagePrice.toFixed(2)}`);
    console.log(`   Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleDateString() : 'Never'}`);

    // Check for unmatched products
    const unmatchedFile = path.join(__dirname, '../../../../services/metalcloak/unmatched/metalcloak-unmatched.json');
    if (fs.existsSync(unmatchedFile)) {
      const unmatched = JSON.parse(fs.readFileSync(unmatchedFile, 'utf8'));
      console.log(`\n⚠️  Unmatched products: ${unmatched.length}`);
      console.log(`   Review file: ${unmatchedFile}`);
      console.log('   These products need manual SKU mapping');
    }

    console.log('\n✅ MetalCloak integration completed successfully!');

  } catch (error) {
    console.error('❌ Integration failed:', error.message);
  } finally {
    await metalcloak.close();
  }
}

// Run if called directly
if (require.main === module) {
  const filePathArg = process.argv[2];
  runMetalCloakIntegration(filePathArg).catch(console.error);
}

module.exports = runMetalCloakIntegration;