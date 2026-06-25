const meyerApiUs = require("../api-calls/meyer-api-us.js");

const prisma = require("../../../lib/prisma");

function safeFloat(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isBajaBrand(brandName) {
  return String(brandName || "").trim().toLowerCase() === "baja designs";
}

function normalizeBajaVendorPart(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  const prefixedDashed = raw.match(/^(?:BAJ|BAJA\s*DESIGNS)[-\s]?(\d{2})-(\d+)$/);
  if (prefixedDashed) {
    return `${prefixedDashed[1]}-${prefixedDashed[2]}`;
  }

  const prefixed = raw.match(/^BAJ[-\s]?(\d+)$/);
  if (prefixed) {
    const digits = prefixed[1];
    if (digits.length < 5) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }

  const dashed = raw.match(/^(\d{2})-(\d+)$/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;

  const compact = raw.match(/^(\d+)$/);
  if (compact) {
    const digits = compact[1];
    if (digits.length < 5) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }

  return null;
}

function toBajaVendorPart(value) {
  const normalized = normalizeBajaVendorPart(value);
  if (!normalized) return null;
  return normalized;
}

function resolveMeyerProductSku(map, itemNumber) {
  const raw = String(itemNumber || "").trim();
  if (!raw) return null;
  if (map.has(raw)) return map.get(raw);

  const normalized = normalizeBajaVendorPart(raw);
  if (normalized && map.has(normalized)) return map.get(normalized);

  return null;
}

function shouldRemoveMeyerVendor(item) {
  const partStatus = String(item?.PartStatus || "").trim().toLowerCase();
  const qtyAvailable = safeFloat(item?.QtyAvailable);
  return partStatus === "discontinued" && qtyAvailable === 0;
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
    let vendorProductRemovedCount = 0;
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
        brand_name: true,
      },
    });

    const meyerToProductSku = new Map();
    for (const product of products) {
      if (product.meyer_code) meyerToProductSku.set(product.meyer_code, product.sku);

      if (isBajaBrand(product.brand_name)) {
        const bajaFallbackCode = toBajaVendorPart(product.sku) || toBajaVendorPart(product.meyer_code);
        if (bajaFallbackCode && !meyerToProductSku.has(bajaFallbackCode)) {
          meyerToProductSku.set(bajaFallbackCode, product.sku);
        }
      }
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

    const flushDeleteBatch = async (productSkus) => {
      if (!productSkus.length) return 0;

      const res = await prisma.vendorProduct.deleteMany({
        where: {
          vendor_id: 2,
          product_sku: { in: productSkus },
        },
      });

      return Number(res?.count || 0);
    };

    let dbBuffer = [];
    const deleteSkuSet = new Set();

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of vendorProductsData) {
      try {
        if (!data || data.statusCode || !Array.isArray(data) || !data[0]) {
          continue;
        }

        const item = data[0];
        const productSku = resolveMeyerProductSku(meyerToProductSku, item.ItemNumber);
        if (!productSku) {
          console.error(`Product not found for meyer_code: ${item.ItemNumber}`);
          continue;
        }

        if (shouldRemoveMeyerVendor(item)) {
          deleteSkuSet.add(productSku);
          dbBuffer = dbBuffer.filter((row) => row.product_sku !== productSku);
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

    if (deleteSkuSet.size) {
      const deleteSkus = Array.from(deleteSkuSet);
      for (let i = 0; i < deleteSkus.length; i += batchSize) {
        const skuBatch = deleteSkus.slice(i, i + batchSize);
        const deleted = await flushDeleteBatch(skuBatch);
        vendorProductRemovedCount += deleted;
      }
    }

    console.log(`Meyer US vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}
      Total vendor products removed (discontinued + zero qty): ${vendorProductRemovedCount}`);
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
