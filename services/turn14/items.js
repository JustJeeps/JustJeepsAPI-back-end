const Turn14Auth = require('./auth');

class Turn14Items {
  constructor() {
    this.auth = new Turn14Auth();
  }

  /**
   * Get all items with pagination support
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Items data with pagination info
   */
  async getAllItems(page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/items?page=${page}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching Turn14 items:', error.message);
      throw error;
    }
  }

  /**
   * Get a single item by item_id
   * @param {string} itemId - Turn14 item ID
   * @returns {Promise<object>} Item data
   */
  async getItem(itemId) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/items/${itemId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching Turn14 item ${itemId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all items for a specific brand
   * @param {number} brandId - Turn14 brand ID
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Brand items data with pagination info
   */
  async getBrandItems(brandId, page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/items/brand/${brandId}?page=${page}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching Turn14 brand ${brandId} items:`, error.message);
      throw error;
    }
  }

  /**
   * Get all brands available in Turn14
   * @returns {Promise<object>} Brands data
   */
  async getAllBrands() {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get('/v1/brands');
      return response.data;
    } catch (error) {
      console.error('Error fetching Turn14 brands:', error.message);
      throw error;
    }
  }

  /**
   * Get a specific brand by brand_id
   * @param {number} brandId - Turn14 brand ID
   * @returns {Promise<object>} Brand data
   */
  async getBrand(brandId) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/brands/${brandId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching Turn14 brand ${brandId}:`, error.message);
      throw error;
    }
  }

  /**
   * Search for items by part number pattern
   * This requires fetching items and filtering by part_number since Turn14 doesn't have direct part number search
   * @param {string} partNumber - Part number to search for
   * @param {number} brandId - Optional brand ID to filter results
   * @returns {Promise<array>} Matching items
   */
  async searchByPartNumber(partNumber, brandId = null) {
    try {
      const matchingItems = [];
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages && page <= 10) { // Limit to 10 pages to prevent excessive API calls
        let itemsData;
        
        if (brandId) {
          itemsData = await this.getBrandItems(brandId, page);
        } else {
          itemsData = await this.getAllItems(page);
        }

        if (itemsData.data && itemsData.data.length > 0) {
          // Filter items by part number
          const matches = itemsData.data.filter(item => 
            item.attributes.part_number && 
            item.attributes.part_number.toLowerCase().includes(partNumber.toLowerCase())
          );
          matchingItems.push(...matches);

          // Check if there are more pages
          hasMorePages = itemsData.meta && page < itemsData.meta.total_pages;
          page++;
        } else {
          hasMorePages = false;
        }
      }

      return matchingItems;
    } catch (error) {
      console.error(`Error searching for part number ${partNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Find Turn14 brand ID by brand name (using t14_code)
   * @param {string} brandName - Brand name to search for (t14_code value)
   * @returns {Promise<number|null>} Brand ID if found, null otherwise
   */
  async findBrandIdByName(brandName) {
    try {
      const brandsData = await this.getAllBrands();
      
      if (brandsData.data) {
        // Look for exact match first
        let brand = brandsData.data.find(b => 
          b.attributes.name.toLowerCase() === brandName.toLowerCase()
        );

        // If no exact match, try partial match
        if (!brand) {
          brand = brandsData.data.find(b => 
            b.attributes.name.toLowerCase().includes(brandName.toLowerCase()) ||
            brandName.toLowerCase().includes(b.attributes.name.toLowerCase())
          );
        }

        if (brand) {
          return parseInt(brand.id);
        }
      }

      return null;
    } catch (error) {
      console.error(`Error finding brand ID for ${brandName}:`, error.message);
      return null;
    }
  }

  /**
   * Get items updated within a specific number of days
   * @param {number} days - Number of days (1-15)
   * @param {number} page - Page number (default: 1)
   * @returns {Promise<object>} Updated items data
   */
  async getUpdatedItems(days = 1, page = 1) {
    try {
      const client = await this.auth.getAuthenticatedClient();
      const response = await client.get(`/v1/items/updates?page=${page}&days=${days}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching updated items for ${days} days:`, error.message);
      throw error;
    }
  }
}

module.exports = Turn14Items;