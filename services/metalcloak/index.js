const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

/**
 * MetalCloak Database Integration Service
 * 
 * This service processes scraped MetalCloak data and integrates it into the database.
 * Since MetalCloak requires manual login (CAPTCHA), this is designed for batch processing
 * of scraped data files rather than real-time API integration.
 * 
 * Note: MetalCloak prices are in USD and are automatically converted to CAD by multiplying by 1.50
 */
class MetalCloakService {
  constructor() {
    this.prisma = new PrismaClient();
    this.vendorId = 17; // MetalCloak is 17th position in vendors_data.js, will get vendor_id 17
    this.vendorName = 'MetalCloak';
  }

  /**
   * Process a scraped MetalCloak JSON file and update database
   * @param {string} filePath - Path to the JSON file from scraper
   * @returns {Promise<Object>} - Processing results
   */
  async processScrapedData(filePath) {
    console.log(`🔄 Processing MetalCloak data from: ${filePath}`);

    try {
      // Read and validate scraped data
      const jsonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (!jsonData.products || !Array.isArray(jsonData.products)) {
        throw new Error('Invalid data format: missing products array');
      }

      const products = jsonData.products;
      console.log(`📦 Found ${products.length} products to process`);

      const results = {
        totalProcessed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: []
      };

      // Process products in batches
      const batchSize = 50;
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        console.log(`⚙️  Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(products.length / batchSize)}`);

        for (const product of batch) {
          try {
            await this.processProduct(product);
            results.totalProcessed++;
          } catch (error) {
            results.errors.push({
              productCode: product.productCode,
              error: error.message
            });
          }
        }

        // Rate limiting between batches
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log('✅ MetalCloak data processing completed');
      console.log(`   Processed: ${results.totalProcessed}`);
      console.log(`   Errors: ${results.errors.length}`);

      return results;

    } catch (error) {
      console.error('❌ Failed to process MetalCloak data:', error.message);
      throw error;
    }
  }

  /**
   * Process a single product from scraped data
   * @param {Object} productData - Product data from scraper
   */
  async processProduct(productData) {
    const { 
      title, 
      productCode,  // This is the MetalCloak SKU from CSV
      mapPrice, 
      yourPrice
    } = productData;

    // Skip products without essential data
    if (!productCode || !title) {
      throw new Error('Missing required product data: productCode or title');
    }

    // Convert price strings to numbers
    const yourPriceNumeric = yourPrice ? parseFloat(yourPrice.replace('$', '').replace(',', '')) : null;

    // Try to find existing product by SKU matching
    // MetalCloak uses their own product codes, so we need to match by searchable_sku
    const existingProduct = await this.findMatchingProduct(productCode, title);

    if (existingProduct) {
      // Use product SKU (Product model uses `sku` as the PK)
      const productSku = existingProduct.sku;

      // Update existing product with MetalCloak pricing (cost only, no inventory data)
      await this.updateProductPricing(productSku, {
        vendor_cost: yourPriceNumeric?.toString()
      });

      console.log(`   ✅ Updated: ${productCode} - ${title.substring(0, 50)}...`);
    } else {
      // Log for manual SKU mapping review
      console.log(`   ⚠️  No match found: ${productCode} - ${title.substring(0, 50)}...`);
      
      // Save unmatched products for review
      await this.saveUnmatchedProduct(productData);
    }
  }

  /**
   * Find matching product in database
   * @param {string} metalCloakCode - MetalCloak product code
   * @param {string} title - Product title
   * @returns {Promise<Object|null>} - Matching product or null
   */
  async findMatchingProduct(metalCloakCode, title) {
    // Match using searchable_sku (like other seeds) and ensure brand is MetalCloak
    const product = await this.prisma.product.findFirst({
      where: {
        searchable_sku: metalCloakCode,
        brand_name: 'MetalCloak'
      }
    });

    return product;
  }

  /**
   * Update product pricing with MetalCloak data
   * @param {number} productId - Product ID
   * @param {Object} pricingData - Pricing information (cost only, no inventory)
   */
  async updateProductPricing(productId, pricingData) {
    // pricingData.vendor_cost is expected to be a string or number (in USD)
    // Convert USD to CAD by multiplying by 1.50
    const usdCost = pricingData.vendor_cost == null ? null : parseFloat(pricingData.vendor_cost);
    const cadCost = usdCost ? usdCost * 1.50 : null;

    // Find existing VendorProduct by product_sku + vendor_id
    const existingVendorProduct = await this.prisma.vendorProduct.findFirst({
      where: {
        product_sku: productId,
        vendor_id: this.vendorId
      }
    });

    if (existingVendorProduct) {
      await this.prisma.vendorProduct.update({
        where: { id: existingVendorProduct.id },
        data: {
          vendor_cost: cadCost
        }
      });
    } else {
      await this.prisma.vendorProduct.create({
        data: {
          product_sku: productId,
          vendor_id: this.vendorId,
          vendor_cost: cadCost,
          vendor_sku: productId // Use the product SKU as vendor_sku since MetalCloak codes match
          // Note: No inventory data - MetalCloak doesn't provide actual quantities
        }
      });
    }
  }

  /**
   * Save unmatched products for manual review
   * @param {Object} productData - Product data
   */
  async saveUnmatchedProduct(productData) {
    const unmatchedDir = path.join(__dirname, 'unmatched');
    if (!fs.existsSync(unmatchedDir)) {
      fs.mkdirSync(unmatchedDir, { recursive: true });
    }

    const unmatchedFile = path.join(unmatchedDir, 'metalcloak-unmatched.json');
    
    let unmatchedData = [];
    if (fs.existsSync(unmatchedFile)) {
      unmatchedData = JSON.parse(fs.readFileSync(unmatchedFile, 'utf8'));
    }

    // Add if not already exists
    const exists = unmatchedData.find(item => item.productCode === productData.productCode);
    if (!exists) {
      unmatchedData.push({
        ...productData,
        needsManualMapping: true,
        addedAt: new Date().toISOString()
      });

      fs.writeFileSync(unmatchedFile, JSON.stringify(unmatchedData, null, 2));
    }
  }

  /**
   * Get MetalCloak pricing statistics
   * @returns {Promise<Object>} - Statistics
   */
  async getMetalCloakStats() {
    const vendorProducts = await this.prisma.vendorProduct.findMany({
      where: { vendor_id: this.vendorId },
      include: { product: true }
    });

    const stats = {
      totalProducts: vendorProducts.length,
      withPricing: vendorProducts.filter(vp => vp.vendor_cost).length,
      averagePrice: 0,
      lastUpdated: null
    };

    if (stats.withPricing > 0) {
      const prices = vendorProducts
        .filter(vp => vp.vendor_cost)
        .map(vp => parseFloat(vp.vendor_cost))
        .filter(price => !isNaN(price));

      stats.averagePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
      
      // VendorProduct does not currently track update timestamps in the schema,
      // so we can't compute a reliable lastUpdated here. Leave as null.
      stats.lastUpdated = null;
    }

    return stats;
  }

  async close() {
    await this.prisma.$disconnect();
  }
}

module.exports = MetalCloakService;