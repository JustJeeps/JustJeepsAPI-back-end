const PremierAuth = require('./auth');

/**
 * Premier Performance Pricing Service
 * Handles pricing data retrieval with batch processing (up to 50 items)
 */
class PremierPricing {
  constructor() {
    this.auth = new PremierAuth();
  }

  /**
   * Get pricing for a single item
   * @param {string} itemNumber - Premier item number
   * @returns {Promise<object>} Pricing data
   */
  async getItemPricing(itemNumber) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      
      const response = await client.get('/pricing', {
        params: { itemNumber }
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error(`Premier pricing error for ${itemNumber}:`, error.message);
      return {
        success: false,
        error: error.message,
        itemNumber
      };
    }
  }

  /**
   * Get pricing for multiple items (batch - up to 50 items)
   * @param {array} itemNumbers - Array of Premier item numbers (max 50)
   * @returns {Promise<object>} Batch pricing data
   */
  async getBatchPricing(itemNumbers) {
    if (!Array.isArray(itemNumbers) || itemNumbers.length === 0) {
      throw new Error('itemNumbers must be a non-empty array');
    }

    if (itemNumbers.length > 50) {
      throw new Error('Premier API allows maximum 50 items per pricing request');
    }

    try {
      const client = await this.auth.getAuthenticatedClient();
      
      const response = await client.get('/pricing', {
        params: { 
          itemNumbers: itemNumbers.join(',')
        }
      });

      return {
        success: true,
        data: response.data,
        itemCount: itemNumbers.length
      };
    } catch (error) {
      console.error(`Premier batch pricing error for ${itemNumbers.length} items:`, error.message);
      return {
        success: false,
        error: error.message,
        itemNumbers,
        itemCount: itemNumbers.length
      };
    }
  }

  /**
   * Process large arrays of item numbers in batches of 50
   * @param {array} itemNumbers - Array of Premier item numbers
   * @returns {Promise<object>} Combined pricing results
   */
  async getBatchPricingLarge(itemNumbers) {
    const batchSize = 50;
    const results = [];
    const errors = [];

    console.log(`Premier: Processing ${itemNumbers.length} items in batches of ${batchSize}`);

    for (let i = 0; i < itemNumbers.length; i += batchSize) {
      const batch = itemNumbers.slice(i, i + batchSize);
      console.log(`Premier: Processing pricing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(itemNumbers.length/batchSize)}`);

      try {
        // Rate limiting - 1 second between batches
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const batchResult = await this.getBatchPricing(batch);
        
        if (batchResult.success) {
          results.push(...(Array.isArray(batchResult.data) ? batchResult.data : [batchResult.data]));
        } else {
          errors.push(batchResult);
        }
      } catch (error) {
        console.error(`Premier: Batch ${Math.floor(i/batchSize) + 1} failed:`, error.message);
        errors.push({
          batch: batch,
          error: error.message
        });
      }
    }

    return {
      success: errors.length === 0,
      results,
      errors,
      totalItems: itemNumbers.length,
      successfulItems: results.length,
      failedBatches: errors.length
    };
  }

  /**
   * Extract cost pricing from Premier pricing response (USD)
   * @param {object} pricingData - Premier pricing response
   * @returns {number} Cost price in USD
   */
  extractCostPrice(pricingData) {
    if (!pricingData || !pricingData.pricing) {
      return 0;
    }

    // Find USD pricing
    const usdPricing = pricingData.pricing.find(p => p.currency === 'USD');
    return usdPricing ? (usdPricing.cost || 0) : 0;
  }

  /**
   * Extract jobber pricing from Premier pricing response (USD)
   * @param {object} pricingData - Premier pricing response
   * @returns {number} Jobber price in USD
   */
  extractJobberPrice(pricingData) {
    if (!pricingData || !pricingData.pricing) {
      return 0;
    }

    // Find USD pricing
    const usdPricing = pricingData.pricing.find(p => p.currency === 'USD');
    return usdPricing ? (usdPricing.jobber || 0) : 0;
  }

  /**
   * Extract MAP pricing from Premier pricing response (USD)
   * @param {object} pricingData - Premier pricing response
   * @returns {number} MAP price in USD
   */
  extractMAPPrice(pricingData) {
    if (!pricingData || !pricingData.pricing) {
      return 0;
    }

    // Find USD pricing
    const usdPricing = pricingData.pricing.find(p => p.currency === 'USD');
    return usdPricing ? (usdPricing.map || 0) : 0;
  }

  /**
   * Get simplified pricing for an item (cost only)
   * @param {string} itemNumber - Premier item number
   * @returns {Promise<object>} Simplified pricing data
   */
  async getSimplifiedItemPricing(itemNumber) {
    try {
      const result = await this.getItemPricing(itemNumber);
      
      if (!result.success) {
        return {
          success: false,
          cost: 0,
          error: result.error
        };
      }

      const cost = this.extractCostPrice(result.data);
      const jobber = this.extractJobberPrice(result.data);
      const map = this.extractMAPPrice(result.data);

      return {
        success: true,
        cost: cost,
        jobber: jobber,
        map: map,
        itemNumber: itemNumber
      };
    } catch (error) {
      console.error(`Premier simplified pricing error for ${itemNumber}:`, error.message);
      return {
        success: false,
        cost: 0,
        error: error.message
      };
    }
  }
}

module.exports = PremierPricing;