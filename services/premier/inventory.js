const PremierAuth = require('./auth');

/**
 * Premier Performance Inventory Service
 * Handles inventory data retrieval with batch processing (up to 50 items)
 */
class PremierInventory {
  constructor() {
    this.auth = new PremierAuth();
  }

  /**
   * Get inventory for a single item
   * @param {string} itemNumber - Premier item number
   * @returns {Promise<object>} Inventory data
   */
  async getItemInventory(itemNumber) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      
      const response = await client.get('/inventory', {
        params: { itemNumber }
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error(`Premier inventory error for ${itemNumber}:`, error.message);
      return {
        success: false,
        error: error.message,
        itemNumber
      };
    }
  }

  /**
   * Get inventory for multiple items (batch - up to 50 items)
   * @param {array} itemNumbers - Array of Premier item numbers (max 50)
   * @returns {Promise<object>} Batch inventory data
   */
  async getBatchInventory(itemNumbers) {
    if (!Array.isArray(itemNumbers) || itemNumbers.length === 0) {
      throw new Error('itemNumbers must be a non-empty array');
    }

    if (itemNumbers.length > 50) {
      throw new Error('Premier API allows maximum 50 items per inventory request');
    }

    try {
      const client = await this.auth.getAuthenticatedClient();
      
      const response = await client.get('/inventory', {
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
      console.error(`Premier batch inventory error for ${itemNumbers.length} items:`, error.message);
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
   * @returns {Promise<object>} Combined inventory results
   */
  async getBatchInventoryLarge(itemNumbers) {
    const batchSize = 50;
    const results = [];
    const errors = [];

    console.log(`Premier: Processing ${itemNumbers.length} items in batches of ${batchSize}`);

    for (let i = 0; i < itemNumbers.length; i += batchSize) {
      const batch = itemNumbers.slice(i, i + batchSize);
      console.log(`Premier: Processing inventory batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(itemNumbers.length/batchSize)}`);

      try {
        // Rate limiting - 1 second between batches
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const batchResult = await this.getBatchInventory(batch);
        
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
   * Calculate total inventory across all warehouses
   * @param {object} inventoryData - Premier inventory response
   * @returns {number} Total available quantity
   */
  calculateTotalInventory(inventoryData) {
    if (!inventoryData || !inventoryData.inventory || !Array.isArray(inventoryData.inventory)) {
      return 0;
    }

    return inventoryData.inventory.reduce((total, warehouse) => {
      return total + (warehouse.quantityAvailable || 0);
    }, 0);
  }

  /**
   * Get US warehouse inventory only
   * @param {object} inventoryData - Premier inventory response
   * @returns {number} US warehouse total quantity
   */
  calculateUSInventory(inventoryData) {
    if (!inventoryData || !inventoryData.inventory || !Array.isArray(inventoryData.inventory)) {
      return 0;
    }

    // Filter for US warehouses (exclude CA warehouses)
    const usWarehouses = inventoryData.inventory.filter(warehouse => 
      warehouse.warehouseCode && warehouse.warehouseCode.includes('-US')
    );

    return usWarehouses.reduce((total, warehouse) => {
      return total + (warehouse.quantityAvailable || 0);
    }, 0);
  }

  /**
   * Get best warehouse for an item (highest inventory)
   * @param {object} inventoryData - Premier inventory response
   * @returns {object} Best warehouse info
   */
  getBestWarehouse(inventoryData) {
    if (!inventoryData || !inventoryData.inventory || !Array.isArray(inventoryData.inventory)) {
      return { warehouseCode: null, quantity: 0 };
    }

    let bestWarehouse = inventoryData.inventory[0];
    
    for (const warehouse of inventoryData.inventory) {
      if ((warehouse.quantityAvailable || 0) > (bestWarehouse.quantityAvailable || 0)) {
        bestWarehouse = warehouse;
      }
    }

    return {
      warehouseCode: bestWarehouse.warehouseCode,
      quantity: bestWarehouse.quantityAvailable || 0
    };
  }

  /**
   * Check item stock availability
   * @param {string} itemNumber - Premier item number
   * @returns {Promise<object>} Stock availability data
   */
  async checkItemStock(itemNumber) {
    try {
      const result = await this.getItemInventory(itemNumber);
      
      if (!result.success) {
        return {
          success: false,
          totalQuantity: 0,
          usQuantity: 0,
          inStock: false,
          error: result.error
        };
      }

      const totalQuantity = this.calculateTotalInventory(result.data);
      const usQuantity = this.calculateUSInventory(result.data);
      const bestWarehouse = this.getBestWarehouse(result.data);

      return {
        success: true,
        totalQuantity: totalQuantity,
        usQuantity: usQuantity,
        inStock: totalQuantity > 0,
        bestWarehouse: bestWarehouse,
        itemNumber: itemNumber,
        warehouses: result.data.inventory || []
      };
    } catch (error) {
      console.error(`Premier stock check error for ${itemNumber}:`, error.message);
      return {
        success: false,
        totalQuantity: 0,
        usQuantity: 0,
        inStock: false,
        error: error.message
      };
    }
  }

  /**
   * Get simplified inventory for an item (total quantity only)
   * @param {string} itemNumber - Premier item number
   * @returns {Promise<object>} Simplified inventory data
   */
  async getSimplifiedItemInventory(itemNumber) {
    try {
      const result = await this.checkItemStock(itemNumber);
      
      return {
        success: result.success,
        quantity: result.totalQuantity || 0,
        inStock: result.inStock || false,
        itemNumber: itemNumber,
        error: result.error
      };
    } catch (error) {
      console.error(`Premier simplified inventory error for ${itemNumber}:`, error.message);
      return {
        success: false,
        quantity: 0,
        inStock: false,
        error: error.message
      };
    }
  }
}

module.exports = PremierInventory;