const keypartsCost = require("../api-calls/keyparts");

const prisma = require("../../../lib/prisma");

const VENDOR_ID = 11;
const COST_MULTIPLIER = 1.5;
const CLEAR_EXISTING = false;
const CREATE_BATCH_SIZE = 500;
const UPDATE_BATCH_SIZE = 100;

const seedKeyPartsProducts = async () => {
  const startTime = process.hrtime.bigint();
  console.log("🔁 Seeding KeyParts vendor products...");

  const products = await keypartsCost();
  let created = 0;
  let updated = 0;

  // ✅ Step 0: Clear old vendor products for KeyParts
  if (CLEAR_EXISTING) {
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } });
    console.log("🗑️ Deleted all existing KeyParts vendor products (vendor_id = 11)");
  }

  const itemsBySku = new Map();
  const duplicateItems = new Set();
  for (const data of products) {
    const item = data?.Item;
    if (!item) {
      continue;
    }
    if (itemsBySku.has(item)) {
      duplicateItems.add(item);
      continue;
    }
    itemsBySku.set(item, data);
  }

  const skuList = Array.from(itemsBySku.keys());

  const [existingVendorProducts, matchingProducts] = await prisma.$transaction([
    prisma.vendorProduct.findMany({
      where: {
        vendor_id: VENDOR_ID,
        vendor_sku: { in: skuList },
      },
      select: {
        id: true,
        vendor_sku: true,
      },
    }),
    prisma.product.findMany({
      where: {
        searchable_sku: { in: skuList },
        jj_prefix: "KEY",
      },
      select: {
        sku: true,
        searchable_sku: true,
      },
    }),
  ]);

  const existingBySku = new Map(
    existingVendorProducts.map((row) => [row.vendor_sku, row])
  );
  const productBySearchableSku = new Map(
    matchingProducts.map((row) => [row.searchable_sku, row])
  );

  const toCreate = [];
  const toUpdate = [];

  for (const [item, data] of itemsBySku) {
    const product = productBySearchableSku.get(item);
    if (!product) {
      console.warn(`❌ Product not found for: ${item}`);
      continue;
    }

    const payload = {
      vendor_cost: Number(data.Cost) * COST_MULTIPLIER,
      vendor_inventory_string: data.Inventory || null,
    };

    const existing = existingBySku.get(item);
    if (existing && !CLEAR_EXISTING) {
      toUpdate.push({ id: existing.id, data: payload });
      continue;
    }

    toCreate.push({
      product_sku: product.sku,
      vendor_id: VENDOR_ID,
      vendor_sku: item,
      ...payload,
    });
  }

  for (let i = 0; i < toCreate.length; i += CREATE_BATCH_SIZE) {
    const batch = toCreate.slice(i, i + CREATE_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }
    const result = await prisma.vendorProduct.createMany({
      data: batch,
      skipDuplicates: true,
    });
    created += result.count;
  }

  for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + UPDATE_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }
    await prisma.$transaction(
      batch.map((row) =>
        prisma.vendorProduct.update({
          where: { id: row.id },
          data: row.data,
        })
      )
    );
    updated += batch.length;
  }

  console.log(`✅ KeyParts seeding complete:
  ➕ Created: ${created}
  🔄 Updated: ${updated}`);

  if (duplicateItems.size > 0) {
    console.warn(
      `⚠️ Skipped ${duplicateItems.size} duplicate SKU(s) from source data.`
    );
  }

  const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  console.log(`⏱️ Execution time: ${elapsedMs.toFixed(2)} ms`);

  await prisma.$disconnect();
};

seedKeyPartsProducts();
