const Turn14Items = require('./items');
const Turn14Pricing = require('./pricing');
const Turn14Inventory = require('./inventory');

class Turn14Service {
  constructor() {
    this.items = new Turn14Items();
    this.pricing = new Turn14Pricing();
    this.inventory = new Turn14Inventory();
  }

  /**
   * Complete Turn14 integration workflow: find items by part number, then get pricing and inventory
   * @param {string} partNumber - Part number to search for (t14_code from vendors_prefix.js)
   * @param {string} brandName - Optional brand name to filter results
   * @returns {Promise<object>} Complete product information from Turn14
   */
  async getProductInfo(partNumber, brandName = null) {
    try {
      console.log(`Starting Turn14 lookup for part number: ${partNumber}${brandName ? ` (brand: ${brandName})` : ''}`);

      // Step 1: Find brand ID if brand name provided
      let brandId = null;
      if (brandName) {
        brandId = await this.items.findBrandIdByName(brandName);
        if (!brandId) {
          console.warn(`Brand not found in Turn14: ${brandName}`);
        }
      }

      // Step 2: Search for items by part number
      const matchingItems = await this.items.searchByPartNumber(partNumber, brandId);
      
      if (!matchingItems || matchingItems.length === 0) {
        return {
          success: false,
          message: `No items found for part number: ${partNumber}`,
          part_number: partNumber,
          brand_name: brandName,
          results: []
        };
      }

      console.log(`Found ${matchingItems.length} matching items for part number: ${partNumber}`);

      // Step 3: Get pricing and inventory for each matching item
      const results = [];
      for (const item of matchingItems) {
        try {
          const itemId = item.id;
          
          // Get pricing and inventory in parallel
          const [pricingInfo, inventoryInfo] = await Promise.all([
            this.pricing.getSimplifiedItemPricing(itemId),
            this.inventory.checkItemStock(itemId)
          ]);

          results.push({
            item_id: itemId,
            part_number: item.attributes.part_number,
            mfr_part_number: item.attributes.mfr_part_number,
            product_name: item.attributes.product_name,
            part_description: item.attributes.part_description,
            brand: item.attributes.brand,
            brand_id: item.attributes.brand_id,
            category: item.attributes.category,
            subcategory: item.attributes.subcategory,
            active: item.attributes.active,
            regular_stock: item.attributes.regular_stock,
            pricing: pricingInfo,
            inventory: inventoryInfo,
            thumbnail: item.attributes.thumbnail,
            dimensions: item.attributes.dimensions,
            clearance_item: item.attributes.clearance_item
          });
        } catch (error) {
          console.error(`Error processing item ${item.id}:`, error.message);
          results.push({
            item_id: item.id,
            part_number: item.attributes.part_number,
            error: `Failed to get pricing/inventory: ${error.message}`
          });
        }
      }

      return {
        success: true,
        message: `Found ${results.length} items for part number: ${partNumber}`,
        part_number: partNumber,
        brand_name: brandName,
        total_matches: matchingItems.length,
        results: results
      };

    } catch (error) {
      console.error(`Error in Turn14 product lookup for ${partNumber}:`, error.message);
      return {
        success: false,
        message: `Error looking up part number: ${partNumber}`,
        part_number: partNumber,
        brand_name: brandName,
        error: error.message,
        results: []
      };
    }
  }

  /**
   * Batch lookup for multiple part numbers with their respective brands
   * @param {array} products - Array of {partNumber, brandName} objects
   * @returns {Promise<array>} Array of product information results
   */
  async getBatchProductInfo(products) {
    try {
      console.log(`Starting batch Turn14 lookup for ${products.length} products`);
      
      const results = [];
      const batchSize = 5; // Process 5 products at a time to avoid rate limits
      
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(products.length / batchSize)}`);
        
        const batchPromises = batch.map(product => 
          this.getProductInfo(product.partNumber, product.brandName)
        );
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Add small delay between batches to be respectful to API
        if (i + batchSize < products.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      return results;
    } catch (error) {
      console.error('Error in batch Turn14 lookup:', error.message);
      throw error;
    }
  }

  /**
   * Get complete product information by Turn14 item ID
   * @param {string} itemId - Turn14 item ID
   * @returns {Promise<object>} Complete product information
   */
  async getProductByItemId(itemId) {
    try {
      // Get item details, pricing, and inventory in parallel
      const [itemData, pricingInfo, inventoryInfo] = await Promise.all([
        this.items.getItem(itemId),
        this.pricing.getSimplifiedItemPricing(itemId),
        this.inventory.checkItemStock(itemId)
      ]);

      if (!itemData || !itemData.data) {
        return {
          success: false,
          message: `Item not found: ${itemId}`,
          item_id: itemId
        };
      }

      const item = itemData.data;
      return {
        success: true,
        item_id: itemId,
        part_number: item.attributes.part_number,
        mfr_part_number: item.attributes.mfr_part_number,
        product_name: item.attributes.product_name,
        part_description: item.attributes.part_description,
        brand: item.attributes.brand,
        brand_id: item.attributes.brand_id,
        category: item.attributes.category,
        subcategory: item.attributes.subcategory,
        active: item.attributes.active,
        regular_stock: item.attributes.regular_stock,
        pricing: pricingInfo,
        inventory: inventoryInfo,
        thumbnail: item.attributes.thumbnail,
        dimensions: item.attributes.dimensions,
        clearance_item: item.attributes.clearance_item,
        powersports_indicator: item.attributes.powersports_indicator,
        air_freight_prohibited: item.attributes.air_freight_prohibited,
        ltl_freight_required: item.attributes.ltl_freight_required
      };
    } catch (error) {
      console.error(`Error getting product by item ID ${itemId}:`, error.message);
      return {
        success: false,
        message: `Error getting product: ${error.message}`,
        item_id: itemId,
        error: error.message
      };
    }
  }

  /**
   * Search for products and get summary information (without detailed pricing/inventory)
   * @param {string} partNumber - Part number to search for
   * @param {string} brandName - Optional brand name
   * @returns {Promise<object>} Search results with basic item information
   */
  async searchProducts(partNumber, brandName = null) {
    try {
      let brandId = null;
      if (brandName) {
        brandId = await this.items.findBrandIdByName(brandName);
      }

      const matchingItems = await this.items.searchByPartNumber(partNumber, brandId);
      
      return {
        success: true,
        message: `Found ${matchingItems.length} items for part number: ${partNumber}`,
        part_number: partNumber,
        brand_name: brandName,
        total_matches: matchingItems.length,
        results: matchingItems.map(item => ({
          item_id: item.id,
          part_number: item.attributes.part_number,
          mfr_part_number: item.attributes.mfr_part_number,
          product_name: item.attributes.product_name,
          brand: item.attributes.brand,
          category: item.attributes.category,
          active: item.attributes.active,
          thumbnail: item.attributes.thumbnail
        }))
      };
    } catch (error) {
      console.error(`Error searching products for ${partNumber}:`, error.message);
      return {
        success: false,
        message: `Error searching for part number: ${partNumber}`,
        part_number: partNumber,
        brand_name: brandName,
        error: error.message,
        results: []
      };
    }
  }

  /**
   * Get all available brands from Turn14
   * @returns {Promise<object>} Brands list
   */
  async getBrands() {
    try {
      const brandsData = await this.items.getAllBrands();
      return {
        success: true,
        brands: brandsData.data.map(brand => ({
          id: brand.id,
          name: brand.attributes.name,
          dropship: brand.attributes.dropship,
          logo: brand.attributes.logo
        }))
      };
    } catch (error) {
      console.error('Error getting Turn14 brands:', error.message);
      return {
        success: false,
        error: error.message,
        brands: []
      };
    }
  }

  /**
   * Get warehouse locations
   * @returns {Promise<object>} Warehouse locations
   */
  async getWarehouses() {
    try {
      const locationsData = await this.inventory.getLocations();
      return {
        success: true,
        locations: locationsData.data
      };
    } catch (error) {
      console.error('Error getting Turn14 locations:', error.message);
      return {
        success: false,
        error: error.message,
        locations: []
      };
    }
  }
}

module.exports = Turn14Service;