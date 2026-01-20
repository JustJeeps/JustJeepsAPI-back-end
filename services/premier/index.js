const PremierAuth = require('./auth');
const PremierPricing = require('./pricing');
const PremierInventory = require('./inventory');

/**
 * Premier Performance Complete Integration Service
 * High-level service for Premier API operations with batch processing
 */
class PremierService {
  constructor() {
    this.auth = new PremierAuth();
    this.pricing = new PremierPricing();
    this.inventory = new PremierInventory();
  }

  /**
   * Get complete product information (pricing + inventory) for a single item
   * @param {string} itemNumber - Premier item number
   * @returns {Promise<object>} Complete product information
   */
  async getProductInfo(itemNumber) {
    try {
      console.log(`Premier: Getting complete product info for ${itemNumber}`);

      // Get pricing and inventory in parallel
      const [pricingResult, inventoryResult] = await Promise.all([
        this.pricing.getSimplifiedItemPricing(itemNumber),
        this.inventory.getSimplifiedItemInventory(itemNumber)
      ]);

      return {
        success: pricingResult.success && inventoryResult.success,
        itemNumber: itemNumber,
        pricing: {
          cost: pricingResult.cost || 0,
          jobber: pricingResult.jobber || 0,
          map: pricingResult.map || 0
        },
        inventory: {
          quantity: inventoryResult.quantity || 0,
          inStock: inventoryResult.inStock || false
        },
        errors: [
          ...(pricingResult.error ? [`Pricing: ${pricingResult.error}`] : []),
          ...(inventoryResult.error ? [`Inventory: ${inventoryResult.error}`] : [])
        ]
      };
    } catch (error) {
      console.error(`Premier: Error getting product info for ${itemNumber}:`, error.message);
      return {
        success: false,
        itemNumber: itemNumber,
        pricing: { cost: 0, jobber: 0, map: 0 },
        inventory: { quantity: 0, inStock: false },
        errors: [error.message]
      };
    }
  }

  /**
   * Get complete product information for multiple items using batch API
   * @param {array} itemNumbers - Array of Premier item numbers
   * @returns {Promise<object>} Batch product information
   */
  async getBatchProductInfo(itemNumbers) {
    if (!Array.isArray(itemNumbers) || itemNumbers.length === 0) {
      throw new Error('itemNumbers must be a non-empty array');
    }

    console.log(`Premier: Getting batch product info for ${itemNumbers.length} items`);

    try {
      // Process in batches of 50 (Premier API limit)
      const results = [];
      const batchSize = 50;

      for (let i = 0; i < itemNumbers.length; i += batchSize) {
        const batch = itemNumbers.slice(i, i + batchSize);
        console.log(`Premier: Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(itemNumbers.length/batchSize)}`);

        // Rate limiting between batches
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Get pricing and inventory for batch in parallel
        const [pricingResults, inventoryResults] = await Promise.all([
          this.pricing.getBatchPricing(batch),
          this.inventory.getBatchInventory(batch)
        ]);

        // Combine results
        const batchResults = this.combineBatchResults(batch, pricingResults, inventoryResults);
        results.push(...batchResults);
      }

      return {
        success: true,
        results: results,
        totalItems: itemNumbers.length,
        successfulItems: results.filter(r => r.success).length
      };
    } catch (error) {
      console.error(`Premier: Batch product info error:`, error.message);
      return {
        success: false,
        results: [],
        totalItems: itemNumbers.length,
        successfulItems: 0,
        error: error.message
      };
    }
  }

  /**
   * Combine batch pricing and inventory results
   * @param {array} itemNumbers - Original item numbers
   * @param {object} pricingResults - Batch pricing results
   * @param {object} inventoryResults - Batch inventory results
   * @returns {array} Combined results
   */
  combineBatchResults(itemNumbers, pricingResults, inventoryResults) {
    const results = [];

    // Create maps for quick lookup
    const pricingMap = new Map();
    const inventoryMap = new Map();

    // Process pricing results
    if (pricingResults.success && pricingResults.data) {
      const pricingData = Array.isArray(pricingResults.data) ? pricingResults.data : [pricingResults.data];
      pricingData.forEach(item => {
        if (item.itemNumber) {
          pricingMap.set(item.itemNumber, item);
        }
      });
    }

    // Process inventory results
    if (inventoryResults.success && inventoryResults.data) {
      const inventoryData = Array.isArray(inventoryResults.data) ? inventoryResults.data : [inventoryResults.data];
      inventoryData.forEach(item => {
        if (item.itemNumber) {
          inventoryMap.set(item.itemNumber, item);
        }
      });
    }

    // Combine data for each item
    itemNumbers.forEach(itemNumber => {
      const pricingData = pricingMap.get(itemNumber);
      const inventoryData = inventoryMap.get(itemNumber);

      const pricing = {
        cost: 0,
        jobber: 0,
        map: 0
      };

      if (pricingData && pricingData.pricing) {
        // Handle both array format and direct object format
        if (Array.isArray(pricingData.pricing)) {
          const usdPricing = pricingData.pricing.find(p => p.currency === 'USD');
          if (usdPricing) {
            pricing.cost = usdPricing.cost || 0;
            pricing.jobber = usdPricing.jobber || 0;
            pricing.map = usdPricing.map || 0;
          }
        } else {
          // Direct pricing object (default USD)
          pricing.cost = pricingData.pricing.cost || 0;
          pricing.jobber = pricingData.pricing.jobber || 0;
          pricing.map = pricingData.pricing.map || 0;
        }
      }

      const inventory = {
        quantity: 0,
        inStock: false
      };

      if (inventoryData && inventoryData.inventory) {
        const totalQuantity = inventoryData.inventory.reduce((total, warehouse) => {
          return total + (warehouse.quantityAvailable || 0);
        }, 0);
        
        inventory.quantity = totalQuantity;
        inventory.inStock = totalQuantity > 0;
      }

      results.push({
        success: pricingData || inventoryData ? true : false,
        itemNumber: itemNumber,
        pricing: pricing,
        inventory: inventory,
        errors: []
      });
    });

    return results;
  }

  /**
   * Test Premier API connection
   * @returns {Promise<object>} Connection test result
   */
  async testConnection() {
    try {
      console.log('Premier: Testing API connection...');
      
      // Test authentication
      const token = await this.auth.getAccessToken();
      
      return {
        success: true,
        message: 'Premier API connection successful',
        tokenReceived: !!token,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Premier: Connection test failed:', error.message);
      return {
        success: false,
        message: 'Premier API connection failed',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get Premier API status and capabilities
   * @returns {Promise<object>} API status information
   */
  async getAPIStatus() {
    try {
      const connectionTest = await this.testConnection();
      
      return {
        success: connectionTest.success,
        apiName: 'Premier Performance',
        apiVersion: 'v5',
        baseURL: this.auth.baseURL,
        capabilities: {
          batchPricing: true,
          batchInventory: true,
          maxBatchSize: 50,
          multiWarehouse: true,
          multiCurrency: true,
          realTimeInventory: true
        },
        rateLimit: {
          recommended: '1 request per second',
          batchSize: '50 items per request'
        },
        connection: connectionTest,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = PremierService;