const meyerApiUs = require("../api-calls/meyer-api-us.js");

const prisma = require("../../../lib/prisma");

function safeFloat(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function escapeSqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function buildValuesSql(rows) {
  return rows
    .map((row) => {
      const vendorId = Number(row.vendor_id);
      const vendorSku = `'${escapeSqlString(row.vendor_sku)}'`;
      const productSku = `'${escapeSqlString(row.product_sku)}'`;

      const costUsd = row.vendor_cost_usd === null ? "NULL" : Number(row.vendor_cost_usd);
      const inv = row.vendor_inventory === null ? "NULL" : Number(row.vendor_inventory);

      const partStatus =
        row.partStatus_meyer === null || row.partStatus_meyer === undefined || row.partStatus_meyer === ""
          ? "NULL"
          : `'${escapeSqlString(row.partStatus_meyer)}'`;

      const len = row.meyer_length === null ? "NULL" : Number(row.meyer_length);
      const wid = row.meyer_width === null ? "NULL" : Number(row.meyer_width);
      const hei = row.meyer_height === null ? "NULL" : Number(row.meyer_height);
      const wgt = row.meyer_weight === null ? "NULL" : Number(row.meyer_weight);

      return `(${vendorId},${vendorSku},${productSku},${costUsd},${inv},${partStatus},${len},${wid},${hei},${wgt})`;
    })
    .join(",\n");
}

// seed Meyer US products
const seedMeyerUsVendorProducts = async () => {
  const seedStartedAt = Date.now();
  try {
    console.time("seed-meyer-us total");
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    const batchSize = Number(process.env.SEED_MEYER_DB_BATCH_SIZE || 500);

    // Call MeyerCost US and get the processed responses
    const vendorProductsData = await meyerApiUs();

    const products = await prisma.product.findMany({
      where: {
        status: 1,
        meyer_code: { not: "" },
      },
      select: {
        sku: true,
        meyer_code: true,
      },
    });

    const meyerToProductSku = new Map();
    for (const product of products) {
      if (product.meyer_code) meyerToProductSku.set(product.meyer_code, product.sku);
    }

    const flushDbBatch = async (rows) => {
      if (!rows.length) return { inserted: 0, updated: 0, ms: 0 };

      const valuesSql = buildValuesSql(rows);

      const sql = `
WITH incoming(vendor_id, vendor_sku, product_sku, vendor_cost_usd, vendor_inventory, partstatus_meyer, meyer_length, meyer_width, meyer_height, meyer_weight) AS (
  VALUES
  ${valuesSql}
),
updated_vp AS (
  UPDATE "VendorProduct" vp
  SET
    vendor_cost_usd = i.vendor_cost_usd,
    vendor_inventory = i.vendor_inventory,
    "partStatus_meyer" = i.partstatus_meyer
  FROM incoming i
  WHERE vp.vendor_id = i.vendor_id
    AND vp.vendor_sku = i.vendor_sku
  RETURNING vp.id
),
inserted_vp AS (
  INSERT INTO "VendorProduct"(product_sku, vendor_id, vendor_sku, vendor_cost, vendor_cost_usd, vendor_inventory, "partStatus_meyer")
  SELECT
    i.product_sku,
    i.vendor_id,
    i.vendor_sku,
    i.vendor_cost_usd,
    i.vendor_cost_usd,
    i.vendor_inventory,
    i.partstatus_meyer
  FROM incoming i
  LEFT JOIN "VendorProduct" vp
    ON vp.vendor_id = i.vendor_id
   AND vp.vendor_sku = i.vendor_sku
  WHERE vp.id IS NULL
  RETURNING id
),
updated_p AS (
  UPDATE "Product" p
  SET
    "partStatus_meyer" = i.partstatus_meyer,
    meyer_length = i.meyer_length,
    meyer_width = i.meyer_width,
    meyer_height = i.meyer_height,
    meyer_weight = i.meyer_weight
  FROM incoming i
  WHERE p.sku = i.product_sku
  RETURNING p.sku
)
SELECT
  (SELECT COUNT(*) FROM inserted_vp) AS inserted_count,
  (SELECT COUNT(*) FROM updated_vp) AS updated_count,
  (SELECT COUNT(*) FROM updated_p) AS updated_products_count;
`;

      const t0 = Date.now();

      const res = await prisma.$transaction(async (tx) => {
        const out = await tx.$queryRawUnsafe(sql);
        return out?.[0] || { inserted_count: 0, updated_count: 0, updated_products_count: 0 };
      });

      const ms = Date.now() - t0;

      return {
        inserted: Number(res.inserted_count || 0),
        updated: Number(res.updated_count || 0),
        ms,
      };
    };

    let dbBuffer = [];

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of vendorProductsData) {
      try {
        if (!data || data.statusCode || !Array.isArray(data) || !data[0]) {
          continue;
        }

        const item = data[0];
        const productSku = meyerToProductSku.get(item.ItemNumber);
        if (!productSku) {
          console.error(`Product not found for meyer_code: ${item.ItemNumber}`);
          continue;
        }

        const vendorProductData = {
          product_sku: productSku,
          vendor_id: 2,
          vendor_sku: item.ItemNumber,
          vendor_cost_usd: safeFloat(item.CustomerPrice),
          vendor_inventory: safeFloat(item.QtyAvailable),
          partStatus_meyer: item.PartStatus,
          meyer_length: safeFloat(item.Length),
          meyer_width: safeFloat(item.Width),
          meyer_height: safeFloat(item.Height),
          meyer_weight: safeFloat(item.Weight),
        };

        if (vendorProductData.vendor_cost_usd === null) {
          continue;
        }

        dbBuffer.push(vendorProductData);

        if (dbBuffer.length >= batchSize) {
          const { inserted, updated, ms } = await flushDbBatch(dbBuffer);
          vendorProductCreatedCount += inserted;
          vendorProductUpdatedCount += updated;
          console.log(
            `DB batch flush: inserted=${inserted} updated=${updated} batchSize=${dbBuffer.length} flushMs=${ms}`
          );
          dbBuffer = [];
        }
      } catch (error) {
        console.error("Error processing vendor_sku:", error);
      }
    }

    if (dbBuffer.length) {
      const { inserted, updated, ms } = await flushDbBatch(dbBuffer);
      vendorProductCreatedCount += inserted;
      vendorProductUpdatedCount += updated;
      console.log(
        `Final DB batch flush: inserted=${inserted} updated=${updated} batchSize=${dbBuffer.length} flushMs=${ms}`
      );
      dbBuffer = [];
    }

    console.log(`Meyer US vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from Meyer US:", error);
  } finally {
    await prisma.$disconnect();
    console.timeEnd("seed-meyer-us total");
    const mins = ((Date.now() - seedStartedAt) / 60000).toFixed(2);
    console.log(`seed-meyer-us finished in ${mins} minutes.`);
  }
};

seedMeyerUsVendorProducts();
module.exports = seedMeyerUsVendorProducts;
