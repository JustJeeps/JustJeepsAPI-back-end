const ctpCost = require("../api-calls/ctp");

const prisma = require("../../../lib/prisma");

const seedCTPProducts = async () => {
  console.log("🔁 Seeding CTP vendor products...");

  const products = await ctpCost();
  let created = 0;
  let updated = 0;

    //   // ✅ Step 0: Clear old vendor products for CTP
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 12 } });
    // console.log("🗑️ Deleted all existing CTP vendor products (vendor_id = 12)");

  for (const data of products) {
    try {
      const existing = await prisma.vendorProduct.findFirst({
        where: {
          vendor_id: 12,
          vendor_sku: data.Item,
        },
      });

      if (existing) {
        await prisma.vendorProduct.update({
          where: { id: existing.id },
          data: {
            vendor_cost: data.Cost,
            vendor_inventory: data.Inventory || null,
          },
        });
        updated++;
        continue;
      }

      // Match using ctp_code instead of searchable_sku
      const product = await prisma.product.findFirst({
        where: {
          ctp_code: data.Item,
        },
      });

      if (!product) {
        console.warn(`❌ Product not found for: ${data.Item}`);
        continue;
      }

      await prisma.vendorProduct.create({
        data: {
          product_sku: product.sku,
          vendor_id: 12,
          vendor_sku: data.Item,
          vendor_cost: data.Cost,
          vendor_inventory: data.Inventory || null,
        },
      });
      created++;
    } catch (err) {
      console.error(`🔥 Error for ${data.Item}:`, err.message);
    }
  }

  console.log(`✅ CTP seeding complete:
  ➕ Created: ${created}
  🔄 Updated: ${updated}`);

  await prisma.$disconnect();
};

seedCTPProducts();
