const Turn14Auth = require('./auth');

class Turn14Pricing {
  constructor() {
    this.auth = new Turn14Auth();
  }

  /**
   * Get pricing for all items with pagination
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Pricing data with pagination info
   */
  async getAllPricing(page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/pricing?page=${page}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching Turn14 pricing:', error.message);
      throw error;
    }
  }

  /**
   * Get pricing for a specific item by item_id
   * @param {string} itemId - Turn14 item ID
   * @returns {Promise<object>} Item pricing data
   */
  async getItemPricing(itemId) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/pricing/${itemId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching pricing for item ${itemId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get pricing for all items in a specific brand
   * @param {number} brandId - Turn14 brand ID
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Brand pricing data with pagination info
   */
  async getBrandPricing(brandId, page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/pricing/brand/${brandId}?page=${page}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching pricing for brand ${brandId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get pricing for items in a specific brand and price group
   * @param {number} brandId - Turn14 brand ID
   * @param {number} pricegroupId - Turn14 pricegroup ID
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Pricegroup pricing data with pagination info
   */
  async getPricegroupPricing(brandId, pricegroupId, page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/pricing/brand/${brandId}/pricegroup/${pricegroupId}?page=${page}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching pricing for brand ${brandId} pricegroup ${pricegroupId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get pricing changes within a date range
   * @param {string} startDate - Start date in YYYY-MM-DD format
   * @param {string} endDate - End date in YYYY-MM-DD format
   * @returns {Promise<object>} Pricing changes data
   */
  async getPricingChanges(startDate, endDate) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/pricing/changes?start_date=${startDate}&end_date=${endDate}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching pricing changes from ${startDate} to ${endDate}:`, error.message);
      throw error;
    }
  }

  /**
   * Get pricing for multiple items by their item IDs
   * @param {array} itemIds - Array of Turn14 item IDs
   * @returns {Promise<array>} Array of pricing data for each item
   */
  async getMultipleItemPricing(itemIds) {
    try {
      const pricingPromises = itemIds.map(itemId => 
        this.getItemPricing(itemId).catch(error => {
          console.warn(`Failed to get pricing for item ${itemId}:`, error.message);
          return null;
        })
      );

      const results = await Promise.all(pricingPromises);
      return results.filter(result => result !== null);
    } catch (error) {
      console.error('Error fetching multiple item pricing:', error.message);
      throw error;
    }
  }

  /**
   * Extract cost and pricing information from pricing response
   * @param {object} pricingData - Pricing response from Turn14 API
   * @returns {object} Simplified pricing information
   */
  extractPricingInfo(pricingData) {
    if (!pricingData || !pricingData.data || !pricingData.data.attributes) {
      return null;
    }

    const attributes = pricingData.data.attributes;
    const result = {
      item_id: pricingData.data.id,
      purchase_cost: attributes.purchase_cost,
      has_map: attributes.has_map,
      can_purchase: attributes.can_purchase,
      pricelists: {}
    };

    // Convert pricelists array to object for easier access
    if (attributes.pricelists && attributes.pricelists.length > 0) {
      attributes.pricelists.forEach(pricelist => {
        result.pricelists[pricelist.name.toLowerCase()] = pricelist.price;
      });
    }

    return result;
  }

  /**
   * Get simplified pricing info for an item
   * @param {string} itemId - Turn14 item ID
   * @returns {Promise<object|null>} Simplified pricing information
   */
  async getSimplifiedItemPricing(itemId) {
    try {
      const pricingData = await this.getItemPricing(itemId);
      return this.extractPricingInfo(pricingData);
    } catch (error) {
      console.error(`Error getting simplified pricing for item ${itemId}:`, error.message);
      return null;
    }
  }
}

module.exports = Turn14Pricing;