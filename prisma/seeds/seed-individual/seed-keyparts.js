const keypartsCost = require("../api-calls/keyparts");

const prisma = require("../../../lib/prisma");

const seedKeyPartsProducts = async () => {
  console.log("🔁 Seeding KeyParts vendor products...");

  const products = await keypartsCost();
  let created = 0;
  let updated = 0;

      // ✅ Step 0: Clear old vendor products for KeyParts
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: 11 } });
    console.log("🗑️ Deleted all existing KeyParts vendor products (vendor_id = 11)");

  for (const data of products) {
    try {
      const existing = await prisma.vendorProduct.findFirst({
        where: {
          vendor_id: 11,
          vendor_sku: data.Item,
        },
      });

      if (existing) {
        await prisma.vendorProduct.update({
          where: { id: existing.id },
          data: {
            vendor_cost: data.Cost*1.5,
            vendor_inventory_string: data.Inventory || null,
          },
        });
        updated++;
        continue;
      }

      const product = await prisma.product.findFirst({
        where: {
          searchable_sku: data.Item,
          jj_prefix: "KEY",
        },
      });

      if (!product) {
        console.warn(`❌ Product not found for: ${data.Item}`);
        continue;
      }

      await prisma.vendorProduct.create({
        data: {
          product_sku: product.sku,
          vendor_id: 11,
          vendor_sku: data.Item,
          vendor_cost: data.Cost*1.5,
          vendor_inventory_string: data.Inventory || null,
        },
      });
      created++;
    } catch (err) {
      console.error(`🔥 Error for ${data.Item}:`, err.message);
    }
  }

  console.log(`✅ KeyParts seeding complete:
  ➕ Created: ${created}
  🔄 Updated: ${updated}`);

  await prisma.$disconnect();
};

seedKeyPartsProducts();
