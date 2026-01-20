const Turn14Auth = require('./auth');

class Turn14Inventory {
  constructor() {
    this.auth = new Turn14Auth();
  }

  /**
   * Get inventory for all items with pagination
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Inventory data with pagination info
   */
  async getAllInventory(page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/inventory?page=${page}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching Turn14 inventory:', error.message);
      throw error;
    }
  }

  /**
   * Get inventory for specific items by item IDs (comma-separated, max 250 items)
   * @param {string|array} itemIds - Item ID or array of item IDs
   * @returns {Promise<object>} Inventory data for specified items
   */
  async getItemInventory(itemIds) {
    try {
      const itemIdString = Array.isArray(itemIds) ? itemIds.join(',') : itemIds;
      
      // Validate item count limit
      const itemCount = itemIdString.split(',').length;
      if (itemCount > 250) {
        throw new Error('Maximum 250 items allowed per inventory request');
      }

      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/inventory/${itemIdString}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching inventory for items ${itemIds}:`, error.message);
      throw error;
    }
  }

  /**
   * Get inventory for all items in a specific brand
   * @param {number} brandId - Turn14 brand ID
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Brand inventory data with pagination info
   */
  async getBrandInventory(brandId, page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/inventory/brand/${brandId}?page=${page}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching inventory for brand ${brandId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get inventory for items in a specific brand and price group
   * @param {number} brandId - Turn14 brand ID
   * @param {number} pricegroupId - Turn14 pricegroup ID
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Pricegroup inventory data with pagination info
   */
  async getPricegroupInventory(brandId, pricegroupId, page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/inventory/brand/${brandId}/pricegroup/${pricegroupId}?page=${page}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching inventory for brand ${brandId} pricegroup ${pricegroupId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get recently updated inventory within specified minutes
   * @param {number} minutes - Minutes to look back (15, 30, 60, 240, 480, or 1440)
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Updated inventory data
   */
  async getUpdatedInventory(minutes = 60, page = 1) {
    try {
      // Validate minutes parameter
      const validMinutes = [15, 30, 60, 240, 480, 1440];
      if (!validMinutes.includes(minutes)) {
        throw new Error(`Invalid minutes value. Must be one of: ${validMinutes.join(', ')}`);
      }

      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/inventory/updates?page=${page}&minutes=${minutes}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching updated inventory for ${minutes} minutes:`, error.message);
      throw error;
    }
  }

  /**
   * Get all Turn14 warehouse locations
   * @returns {Promise<object>} Locations data
   */
  async getLocations() {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get('/v1/locations');
      return response.data;
    } catch (error) {
      console.error('Error fetching Turn14 locations:', error.message);
      throw error;
    }
  }

  /**
   * Extract inventory information from inventory response
   * @param {object} inventoryData - Inventory response from Turn14 API
   * @returns {object} Simplified inventory information
   */
  extractInventoryInfo(inventoryData) {
    if (!inventoryData || !inventoryData.data) {
      return null;
    }

    const items = Array.isArray(inventoryData.data) ? inventoryData.data : [inventoryData.data];
    
    return items.map(item => {
      const result = {
        item_id: item.id,
        inventory: item.attributes.inventory || {},
        manufacturer: item.attributes.manufacturer || {},
        eta: item.attributes.eta || null,
        total_available: 0
      };

      // Calculate total available inventory across all locations
      if (result.inventory) {
        result.total_available = Object.values(result.inventory).reduce((sum, qty) => sum + (qty || 0), 0);
      }

      return result;
    });
  }

  /**
   * Get simplified inventory info for specific items
   * @param {string|array} itemIds - Item ID or array of item IDs
   * @returns {Promise<array>} Simplified inventory information
   */
  async getSimplifiedInventory(itemIds) {
    try {
      const inventoryData = await this.getItemInventory(itemIds);
      return this.extractInventoryInfo(inventoryData);
    } catch (error) {
      console.error(`Error getting simplified inventory for items ${itemIds}:`, error.message);
      return null;
    }
  }

  /**
   * Check if item is in stock at any location
   * @param {string} itemId - Turn14 item ID
   * @returns {Promise<object>} Stock status information
   */
  async checkItemStock(itemId) {
    try {
      const inventoryData = await this.getItemInventory(itemId);
      const simplified = this.extractInventoryInfo(inventoryData);
      
      if (!simplified || simplified.length === 0) {
        return {
          item_id: itemId,
          in_stock: false,
          total_available: 0,
          locations: {}
        };
      }

      const item = simplified[0];
      return {
        item_id: itemId,
        in_stock: item.total_available > 0,
        total_available: item.total_available,
        locations: item.inventory,
        manufacturer_stock: item.manufacturer,
        eta: item.eta
      };
    } catch (error) {
      console.error(`Error checking stock for item ${itemId}:`, error.message);
      return {
        item_id: itemId,
        in_stock: false,
        total_available: 0,
        locations: {},
        error: error.message
      };
    }
  }

  /**
   * Get inventory for multiple items with stock status
   * @param {array} itemIds - Array of Turn14 item IDs
   * @returns {Promise<array>} Array of stock status for each item
   */
  async checkMultipleItemsStock(itemIds) {
    try {
      // Split into chunks of 250 (API limit)
      const chunks = [];
      for (let i = 0; i < itemIds.length; i += 250) {
        chunks.push(itemIds.slice(i, i + 250));
      }

      const allResults = [];
      for (const chunk of chunks) {
        try {
          const inventoryData = await this.getItemInventory(chunk);
          const simplified = this.extractInventoryInfo(inventoryData);
          
          if (simplified) {
            simplified.forEach(item => {
              allResults.push({
                item_id: item.item_id,
                in_stock: item.total_available > 0,
                total_available: item.total_available,
                locations: item.inventory,
                manufacturer_stock: item.manufacturer,
                eta: item.eta
              });
            });
          }
        } catch (error) {
          console.warn(`Failed to get inventory for chunk:`, error.message);
          // Add error entries for this chunk
          chunk.forEach(itemId => {
            allResults.push({
              item_id: itemId,
              in_stock: false,
              total_available: 0,
              locations: {},
              error: error.message
            });
          });
        }
      }

      return allResults;
    } catch (error) {
      console.error('Error checking multiple items stock:', error.message);
      throw error;
    }
  }
}

module.exports = Turn14Inventory;