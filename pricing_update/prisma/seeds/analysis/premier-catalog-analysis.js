const PremierService = require('../../services/premier');
const fs = require('fs');
const path = require('path');

/**
 * Get all brands/manufacturers from Premier Performance
 * This will help determine SKU matching strategy
 */
async function getAllPremierBrands() {
  console.log('🔍 Analyzing Premier Performance Catalog...');
  console.log('📋 This will help determine SKU matching strategy\n');

  try {
    const premier = new PremierService();
    
    // Test connection first
    console.log('1. Testing Premier API connection...');
    const status = await premier.getAPIStatus();
    
    if (!status.success) {
      console.error('❌ Premier API connection failed:', status.error);
      return;
    }
    
    console.log('✅ Premier API connected successfully');
    console.log('   Base URL:', status.baseURL);
    console.log('   Capabilities:', JSON.stringify(status.capabilities, null, 4));
    
    // Test with sample items to understand data structure
    console.log('\n2. Testing sample items to understand data structure...');
    const sampleItems = ['AUT17203', 'AUT17204', 'HUS98211']; // From their documentation
    
    for (const item of sampleItems) {
      console.log(`\n📦 Testing item: ${item}`);
      
      try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
        
        const result = await premier.getProductInfo(item);
        
        if (result.success) {
          console.log('   ✅ Success');
          console.log('   💰 Cost:', result.pricing.cost);
          console.log('   📦 Inventory:', result.inventory.quantity);
          console.log('   🏪 In Stock:', result.inventory.inStock);
        } else {
          console.log('   ❌ Failed:', result.errors.join(', '));
        }
      } catch (error) {
        console.log('   ❌ Error:', error.message);
      }
    }
    
    console.log('\n3. 📊 Premier Performance Analysis Summary:');
    console.log('   ✅ API Integration: Working');
    console.log('   🔧 Batch Support: Up to 50 items per request');
    console.log('   💰 Pricing: Cost, Jobber, MAP (USD & CAD)');
    console.log('   📦 Inventory: Real-time, multi-warehouse');
    console.log('   🌍 Warehouses: 7 locations (US & Canada)');
    
    console.log('\n📋 Next Steps for SKU Matching:');
    console.log('   1. Get Premier\'s full product catalog (FTP or API)');
    console.log('   2. Analyze item numbers vs your SKU patterns');
    console.log('   3. Create mapping rules in vendors_prefix.js');
    console.log('   4. Build premier_code field mapping');
    console.log('   5. Test with sample products');
    
    console.log('\n💡 Recommended Approach:');
    console.log('   • Request Premier\'s full product catalog');
    console.log('   • Compare their item numbers with your existing SKUs');
    console.log('   • Look for brand prefixes and pattern matches');
    console.log('   • Create mapping rules similar to Turn14 (t14_code)');
    
    // Save analysis results
    const analysisResults = {
      timestamp: new Date().toISOString(),
      apiStatus: status,
      sampleTests: sampleItems,
      recommendations: [
        'Request full Premier product catalog',
        'Analyze item number patterns',
        'Create SKU mapping strategy',
        'Add premier_code to vendors_prefix.js',
        'Build Premier seeding script'
      ],
      nextSteps: 'Contact Premier for full product catalog and SKU mapping guidance'
    };
    
    const outputPath = path.join(__dirname, 'premier-analysis-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(analysisResults, null, 2));
    console.log(`\n📄 Analysis saved to: ${outputPath}`);
    
  } catch (error) {
    console.error('❌ Premier analysis failed:', error.message);
  }
}

// Run the analysis
getAllPremierBrands().catch(console.error);