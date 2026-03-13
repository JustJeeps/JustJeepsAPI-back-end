const prisma = require("../../../lib/prisma");
const omixCost = require("../api-calls/omix-excel.js");

const VENDOR_ID = 3; // Omix
const IN_QUERY_CHUNK_SIZE = 1000;
const UPSERT_BATCH_SIZE = 2000;

const chunkArray = (items, chunkSize) => {
  if (!items.length) return [];
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const normalizePartNumber = (value) => {
  const text = value == null ? "" : String(value).trim();
  if (!text) return "";

  // Normalize numeric-like part numbers so 15301.20 and 15301.2 match.
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return text;

  return text
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
};

const upsertVendorProductsBatch = async (rows) => {
  if (!rows.length) return;

  const payload = JSON.stringify(rows);

  const updateSql = `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($2::jsonb) AS x(
        vendor_sku text,
        canonical_vendor_sku text,
        vendor_cost double precision,
        product_sku text
      )
    )
    UPDATE "VendorProduct" vp
    SET
      vendor_sku = input.vendor_sku,
      vendor_cost = input.vendor_cost,
      vendor_id = $1
    FROM input
    WHERE vp.vendor_id = $1
      AND (
        vp.vendor_sku = input.vendor_sku
        OR (
          input.canonical_vendor_sku IS NOT NULL
          AND input.canonical_vendor_sku <> ''
          AND vp.vendor_sku = input.canonical_vendor_sku
        )
      );
  `;

  const insertSql = `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($2::jsonb) AS x(
        vendor_sku text,
        canonical_vendor_sku text,
        vendor_cost double precision,
        product_sku text
      )
    )
    INSERT INTO "VendorProduct" (
      product_sku,
      vendor_id,
      vendor_sku,
      vendor_cost
    )
    SELECT
      input.product_sku,
      $1,
      input.vendor_sku,
      input.vendor_cost
    FROM input
    WHERE input.product_sku IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = $1
          AND (
            vp.vendor_sku = input.vendor_sku
            OR (
              input.canonical_vendor_sku IS NOT NULL
              AND input.canonical_vendor_sku <> ''
              AND vp.vendor_sku = input.canonical_vendor_sku
            )
          )
      );
  `;

  await prisma.$transaction([
    prisma.$executeRawUnsafe(updateSql, VENDOR_ID, payload),
    prisma.$executeRawUnsafe(insertSql, VENDOR_ID, payload),
  ]);
};

// seed Omix products
const seedOmix = async () => {
  try {
    const startedAt = Date.now();
    // Call OmixAPI and get the processed responses
    const vendorProductsData = await omixCost();
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // // ✅ Optional: Clear old vendor products for Omix (dangerous in prod)
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } });
    // console.log("🗑️ Deleted all existing Omix vendor products (vendor_id = 3)");

    const normalizedByPartNumber = new Map();

    for (const data of vendorProductsData) {
      // Defensive reads
      const partNumberRaw = data?.["Part Number"];
      const quotedRaw = data?.["Quoted Price"];
      const partNumber =
        partNumberRaw == null ? null : String(partNumberRaw).trim();

      if (!partNumber || quotedRaw == null) {
        // Skip malformed rows
        continue;
      }

      const quoted = Number(quotedRaw);
      if (Number.isNaN(quoted)) {
        // Skip rows with non-numeric price
        continue;
      }

      // Business rule: 1.5x multiplier
      const vendorCost = quoted * 1.5;
      const canonicalPartNumber = normalizePartNumber(partNumber);
      const dedupeKey = canonicalPartNumber || partNumber;

      normalizedByPartNumber.set(dedupeKey, {
        partNumber,
        canonicalPartNumber,
        vendorCost,
      });
    }

    const normalizedRows = Array.from(normalizedByPartNumber.values());

    if (normalizedRows.length === 0) {
      console.log("No valid Omix rows found to seed.");
      return;
    }

    const partNumberLookupSet = new Set();
    for (const row of normalizedRows) {
      partNumberLookupSet.add(row.partNumber);
      if (row.canonicalPartNumber) {
        partNumberLookupSet.add(row.canonicalPartNumber);
      }
    }
    const partNumbers = Array.from(partNumberLookupSet);

    // 1) Load existing vendorProduct rows in bulk (scoped by vendor_id = 3)
    const existingVendorProducts = [];
    for (const skuChunk of chunkArray(partNumbers, IN_QUERY_CHUNK_SIZE)) {
      const rows = await prisma.vendorProduct.findMany({
        where: {
          vendor_id: VENDOR_ID,
          vendor_sku: { in: skuChunk },
        },
        select: {
          id: true,
          vendor_sku: true,
        },
      });
      existingVendorProducts.push(...rows);
    }

    const existingVendorProductBySku = new Map();
    for (const row of existingVendorProducts) {
      // Keep first match to mirror prior behavior that updated a single row
      if (!existingVendorProductBySku.has(row.vendor_sku)) {
        existingVendorProductBySku.set(row.vendor_sku, row);
      }

      const canonicalVendorSku = normalizePartNumber(row.vendor_sku);
      if (
        canonicalVendorSku &&
        !existingVendorProductBySku.has(canonicalVendorSku)
      ) {
        existingVendorProductBySku.set(canonicalVendorSku, row);
      }
    }

    // 2) Load Product mapping by omix_code in bulk
    const products = [];
    for (const codeChunk of chunkArray(partNumbers, IN_QUERY_CHUNK_SIZE)) {
      const rows = await prisma.product.findMany({
        where: { omix_code: { in: codeChunk } },
        select: {
          sku: true,
          omix_code: true,
        },
      });
      products.push(...rows);
    }

    const productByOmixCode = new Map();
    for (const product of products) {
      if (product.omix_code && !productByOmixCode.has(product.omix_code)) {
        productByOmixCode.set(product.omix_code, product);
      }

      const canonicalOmixCode = normalizePartNumber(product.omix_code);
      if (canonicalOmixCode && !productByOmixCode.has(canonicalOmixCode)) {
        productByOmixCode.set(canonicalOmixCode, product);
      }
    }

    const upsertRows = [];

    for (const row of normalizedRows) {
      const existingVendorProduct =
        existingVendorProductBySku.get(row.partNumber) ||
        existingVendorProductBySku.get(row.canonicalPartNumber);

      if (existingVendorProduct) {
        vendorProductUpdatedCount++;

        upsertRows.push({
          vendor_sku: row.partNumber,
          canonical_vendor_sku: row.canonicalPartNumber || null,
          vendor_cost: row.vendorCost,
          product_sku: null,
        });
        continue;
      }

      const product =
        productByOmixCode.get(row.partNumber) ||
        productByOmixCode.get(row.canonicalPartNumber);

      if (!product) {
        // Product not found, skip creating vendorProduct
        continue;
      }

      vendorProductCreatedCount++;

      upsertRows.push({
        vendor_sku: row.partNumber,
        canonical_vendor_sku: row.canonicalPartNumber || null,
        vendor_cost: row.vendorCost,
        product_sku: product.sku,
      });
    }

    if (upsertRows.length > 0) {
      console.log(`Upserting ${upsertRows.length} Omix rows in batches of ${UPSERT_BATCH_SIZE}...`);
    }

    let upsertedSoFar = 0;
    for (const batch of chunkArray(upsertRows, UPSERT_BATCH_SIZE)) {
      await upsertVendorProductsBatch(batch);
      upsertedSoFar += batch.length;
      console.log(`Upserted ${upsertedSoFar}/${upsertRows.length} Omix rows...`);
    }

    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log(
      `Vendor products from Omix seeded successfully!\n` +
      `  Total vendor products created: ${vendorProductCreatedCount}\n` +
      `  Total vendor products updated: ${vendorProductUpdatedCount}\n` +
      `  Elapsed: ${durationSeconds}s`
    );
  } catch (error) {
    console.error("Error seeding vendor products from Omix:", error);
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  seedOmix();
}
module.exports = seedOmix;





// const { PrismaClient } = require("@prisma/client");
// const prisma = new PrismaClient();
// const omixCost = require("../api-calls/omix-excel.js");

// // // seed Omix products
// const seedOmix = async () => {
//   try {
//     // Call OmixAPI and get the processed responses
//     const vendorProductsData = await omixCost();
//     let vendorProductCreatedCount = 0;
//     let vendorProductUpdatedCount = 0;

//     //  // ✅ Step 0: Clear old vendor products for Omix
//     // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 3 } });
//     // console.log("🗑️ Deleted all existing Omix vendor products (vendor_id = 3)");

//     // Loop through the vendorProductsData array and create vendor products
//     for (const data of vendorProductsData) {
//       console.log("data", data);

//       // Check if a vendor product with the same vendor_sku already exists
//       const existingCompetitorProduct = await prisma.vendorProduct.findFirst({
//         where: {
//           vendor_sku: data["Part Number"], // Update: Access 'Part Number' key from data object
//         },
//       });

//       console.log("existingCompetitorProduct", existingCompetitorProduct);

//       if (existingCompetitorProduct) {
//         vendorProductUpdatedCount++;
//         console.log(
//           `Vendor product with vendor_sku: ${data['Part Number']} already exists, updating...`
//         );

//         // Update the existing vendor product with new data
//         await prisma.vendorProduct.update({
//           where: {
//             id: existingCompetitorProduct.id, // assuming there's an 'id' field as the primary key
//           },
//           data: {
//             vendor_sku: data["Part Number"], // Update with new vendor_sku
//             vendor_cost: data["Quoted Price"]*1.5, // Update with new vendor_cost
//             // Add any other fields that you want to update
//           },
//         });

//         // console.log(
//         //   `Vendor product with vendor_sku: ${data['Part Number']} updated successfully`
//         // );
//         continue; // Move to next iteration
//       }

//       // Retrieve the product_sku from the Product table using meyer_code as reference
//       let product; // Update: Declare product variable here
//       product = await prisma.product.findFirst({
//         where: {
//           omix_code: data["Part Number"], // Update: Access 'Part Number' key from data object
//         },
//       });
//       // console.log("product", product);

//       if (!product) {
//         // console.error(
//         //   `Product not found for omix_code: ${data['Part Number']}`
//         // );
//         continue;
//       }

//       // Update the data with the retrieved product_sku and vendor_id
//       const vendorProductData = {
//         product_sku: product.sku, // Updated with the correct product SKU',
//         vendor_id: 3, // Updated with the correct vendor ID
//         vendor_sku: data["Part Number"], // Extracted from API response
//         //2 decimal places for vendor_cost
//         vendor_cost: data["Quoted Price"]*1.5, // Extracted from API response
//         // vendor_cost: data["Quoted Price"]*1.40, // Extracted from API response
//         // Add any other fields that you want to create
//       };

//       // Create the vendor product
//       await prisma.vendorProduct.create({
//         data: vendorProductData,
//       });
//       vendorProductCreatedCount++;
//     }

//     // console.log("Vendor products from Omix seeded successfully!");
//     // console.log(`Total vendor products created: ${vendorProductCreatedCount}`);
//     // console.log(`Total vendor products updated: ${vendorProductUpdatedCount}`);
//     console.log(`Vendor products from Omix seeded successfully! 
//       Total vendor products created: ${vendorProductCreatedCount}, 
//       Total vendor products updated: ${vendorProductUpdatedCount}`);
//   } catch (error) {
//     console.error("Error seeding vendor products from Omix:", error);
//   } finally {
//     await prisma.$disconnect();
//   }
// };

// seedOmix();
// module.exports = seedOmix;