const { PrismaClient } = require('@prisma/client');
const Turn14Service = require('../../../services/turn14');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();
const turn14Service = new Turn14Service();

class Turn14ProductSeeder {
  constructor() {
    this.stats = {
      itemsProcessed: 0,
      productsMatched: 0,
      inventoryUpdated: 0,
      errors: 0
    };
    this.checkpointFile = path.join(__dirname, 'turn14-checkpoint.json');
    this.logFile = path.join(__dirname, 'logs', 'turn14-seeding.log');
  }

  async log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    
    try {
      await fs.mkdir(path.dirname(this.logFile), { recursive: true });
      await fs.appendFile(this.logFile, logMessage + '\n');
    } catch (error) {
      console.error('❌ Log write error:', error.message);
    }
  }

  async saveCheckpoint(phase, page) {
    const checkpoint = {
      timestamp: new Date().toISOString(),
      phase, // 'items' or 'inventory'
      lastCompletedPage: page,
      stats: { ...this.stats }
    };
    
    try {
      await fs.writeFile(this.checkpointFile, JSON.stringify(checkpoint, null, 2));
      await this.log(`💾 Checkpoint saved: ${phase} page ${page}`);
    } catch (error) {
      await this.log(`❌ Checkpoint save error: ${error.message}`);
    }
  }

  async loadCheckpoint() {
    try {
      const data = await fs.readFile(this.checkpointFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null; // No checkpoint exists
    }
  }

  /**
   * STEP 1: Seed T14 IDs and costs from /v1/items endpoint
   * Logic: Match item.attributes.part_number with Product.t14_code
   */
  async seedItems(startPage = 1) {
    await this.log('🔥 PHASE 1: Starting items seeding (t14_code → t14_id matching)');
    
    let currentPage = startPage;
    const totalPages = 699;

    while (currentPage <= totalPages) {
      await this.log(`📦 Processing items page ${currentPage}/${totalPages}`);

      try {
        const response = await turn14Service.items.getAllItems(currentPage);
        
        if (!response.data || !Array.isArray(response.data)) {
          await this.log(`⚠️  No data on page ${currentPage}, skipping`);
          currentPage++;
          continue;
        }

        await this.log(`   Found ${response.data.length} items to process`);

        // Process each item on this page
        for (const item of response.data) {
          await this.processItem(item);
        }

        // Save checkpoint every 10 pages
        if (currentPage % 10 === 0) {
          await this.saveCheckpoint('items', currentPage);
        }

        // Move to next page
        currentPage++;
        
        // Rate limiting between pages
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        await this.log(`❌ Error on items page ${currentPage}: ${error.message}`);
        
        if (error.response?.status === 429) {
          await this.log('🚫 Rate limited - waiting 60 seconds...');
          await new Promise(resolve => setTimeout(resolve, 60000));
          continue; // Retry same page
        }
        
        // Skip page and continue
        currentPage++;
        this.stats.errors++;
      }
    }

    await this.log(`✅ Items seeding completed! Matched ${this.stats.productsMatched} products`);
  }

  /**
   * Process single item from Turn14 /v1/items response
   */
  async processItem(item) {
    try {
      this.stats.itemsProcessed++;
      
      const t14Id = item.id;
      const partNumber = item.attributes.part_number;
      
      if (!partNumber) {
        return; // Skip items without part_number
      }

      // Find Product where t14_code matches part_number
      const product = await prisma.product.findFirst({
        where: {
          t14_code: partNumber
        }
      });

      if (!product) {
        return; // We don't carry this T14 product
      }

      // Update Product with t14_id from Turn14
      await prisma.product.update({
        where: {
          sku: product.sku
        },
        data: {
          t14_id: t14Id
        }
      });

      this.stats.productsMatched++;
      await this.log(`   ✅ ${product.sku}: t14_code(${partNumber}) → t14_id(${t14Id})`);

    } catch (error) {
      this.stats.errors++;
      await this.log(`   ❌ Item ${item.id} error: ${error.message}`);
    }
  }

  /**
   * STEP 2: Seed inventory from /v1/inventory endpoint
   * Logic: Match inventory.id with Product.t14_id (from step 1)
   */
  async seedInventory(startPage = 1) {
    await this.log('📊 PHASE 2: Starting inventory seeding (t14_id → inventory update)');
    
    let currentPage = startPage;
    const totalPages = 699;

    while (currentPage <= totalPages) {
      await this.log(`📦 Processing inventory page ${currentPage}/${totalPages}`);

      try {
        const response = await turn14Service.inventory.getAllInventory(currentPage);
        
        if (!response.data || !Array.isArray(response.data)) {
          await this.log(`⚠️  No inventory data on page ${currentPage}, skipping`);
          currentPage++;
          continue;
        }

        await this.log(`   Found ${response.data.length} inventory items to process`);

        // Process each inventory item on this page
        for (const inventoryItem of response.data) {
          await this.processInventoryItem(inventoryItem);
        }

        // Save checkpoint every 10 pages
        if (currentPage % 10 === 0) {
          await this.saveCheckpoint('inventory', currentPage);
        }

        // Move to next page
        currentPage++;
        
        // Rate limiting between pages
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        await this.log(`❌ Error on inventory page ${currentPage}: ${error.message}`);
        
        if (error.response?.status === 429) {
          await this.log('🚫 Rate limited - waiting 60 seconds...');
          await new Promise(resolve => setTimeout(resolve, 60000));
          continue; // Retry same page
        }
        
        // Skip page and continue
        currentPage++;
        this.stats.errors++;
      }
    }

    await this.log(`✅ Inventory seeding completed! Updated ${this.stats.inventoryUpdated} products`);
  }

  /**
   * Process single inventory item from Turn14 /v1/inventory response
   */
  async processInventoryItem(inventoryItem) {
    try {
      const t14Id = inventoryItem.id;
      const inventoryData = inventoryItem.attributes.inventory;

      if (!inventoryData) {
        return; // No inventory data
      }

      // Calculate total inventory across all locations
      const totalInventory = Object.values(inventoryData).reduce((sum, qty) => sum + (qty || 0), 0);

      // Find Product by t14_id (set in step 1)
      const product = await prisma.product.findFirst({
        where: {
          t14_id: t14Id
        }
      });

      if (!product) {
        return; // Product not in our system or wasn't matched in step 1
      }

      // Create VendorProduct record for Turn14
      const existingVendorProduct = await prisma.vendorProduct.findFirst({
        where: {
          product_sku: product.sku,
          vendor_id: 15 // Turn14 vendor ID
        }
      });

      if (existingVendorProduct) {
        // Update existing record
        await prisma.vendorProduct.update({
          where: { id: existingVendorProduct.id },
          data: {
            vendor_inventory: totalInventory
          }
        });
      } else {
        // Create new VendorProduct record
        await prisma.vendorProduct.create({
          data: {
            product_sku: product.sku,
            vendor_id: 15,
            vendor_sku: product.t14_code || '', // Use t14_code as vendor_sku
            vendor_cost: 0, // Cost will be updated separately if available
            vendor_inventory: totalInventory
          }
        });
      }

      this.stats.inventoryUpdated++;
      if (totalInventory > 0) {
        await this.log(`   📦 ${product.sku}: ${totalInventory} units in stock`);
      }

    } catch (error) {
      this.stats.errors++;
      await this.log(`   ❌ Inventory ${inventoryItem.id} error: ${error.message}`);
    }
  }

  /**
   * Run complete seeding process with resume capability
   */
  async run() {
    await this.log('🚀 Starting Turn14 Product Seeding Process');
    
    try {
      // Check for existing checkpoint
      const checkpoint = await this.loadCheckpoint();
      
      if (checkpoint) {
        await this.log(`📁 Found checkpoint: ${checkpoint.phase} page ${checkpoint.lastCompletedPage}`);
        this.stats = { ...checkpoint.stats };
        
        if (checkpoint.phase === 'items') {
          await this.log('🔄 Resuming items seeding...');
          await this.seedItems(checkpoint.lastCompletedPage + 1);
          await this.seedInventory();
        } else if (checkpoint.phase === 'inventory') {
          await this.log('🔄 Resuming inventory seeding...');
          await this.seedInventory(checkpoint.lastCompletedPage + 1);
        }
      } else {
        // Start from beginning
        await this.seedItems();
        await this.seedInventory();
      }

      await this.log('🎉 Complete Turn14 seeding finished successfully!');
      await this.logFinalStats();

      // Remove checkpoint file on success
      try {
        await fs.unlink(this.checkpointFile);
        await this.log('📁 Checkpoint file cleaned up');
      } catch (error) {
        // Ignore error if file doesn't exist
      }

    } catch (error) {
      await this.log(`💥 Fatal error: ${error.message}`);
      throw error;
    } finally {
      await prisma.$disconnect();
    }
  }

  async logFinalStats() {
    await this.log('📊 FINAL STATISTICS:');
    await this.log(`   Items processed: ${this.stats.itemsProcessed}`);
    await this.log(`   Products matched: ${this.stats.productsMatched}`);
    await this.log(`   Inventory updated: ${this.stats.inventoryUpdated}`);
    await this.log(`   Errors: ${this.stats.errors}`);
  }
}

// Command line interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const seeder = new Turn14ProductSeeder();
  
  switch (command) {
    case 'items':
      seeder.seedItems()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;
      
    case 'inventory':
      seeder.seedInventory()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;
      
    case 'resume':
      seeder.run()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;
      
    default:
      seeder.run()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
  }
}

module.exports = Turn14ProductSeeder;