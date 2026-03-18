const prisma = require("../../../lib/prisma");
const quadratecCost = require("../api-calls/quadratec-excel.js");

const VENDOR_ID = 4;
const BATCH_SIZE = 5000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function seedQuadratec() {
  console.time("seed-quadratec total");

  try {
    console.time("fetch quadratecCost");
    const raw = await quadratecCost();
    console.timeEnd("fetch quadratecCost");

    if (!Array.isArray(raw) || raw.length === 0) {
      console.log("No data returned from quadratecCost()");
      return;
    }

    // 1) Clean + normalize + dedupe by quadratec_code
    // Keep the LAST occurrence if duplicates exist
    const mapByCode = new Map();
    for (const r of raw) {
      const wholesale = Number(r?.wholesalePrice);
      const retail = Number(r?.retailPrice);
      if (!Number.isFinite(wholesale)) continue;

      const codes = [
        { value: r?.quadratec_code, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt4, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt5, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt6, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt7, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt8, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt9, quadratecBrandOnly: false },
        { value: r?.quadratec_code_alt2, quadratecBrandOnly: true },
        { value: r?.quadratec_code_alt3, quadratecBrandOnly: true },
      ]
        .map((item) => ({
          value: (item.value ?? "").trim(),
          quadratecBrandOnly: item.quadratecBrandOnly,
        }))
        .filter((item) => item.value);

      if (codes.length === 0) continue;

      for (const { value: code, quadratecBrandOnly } of codes) {
        mapByCode.set(code, {
          quadratec_code: code,
          quadratec_brand_only_match: quadratecBrandOnly,
          quadratec_sku: r?.quadratec_sku ?? null,
          vendor_cost_usd: round2(wholesale),
          vendor_cost: round2(wholesale * 1.5),
          vendor_retail_price_usd: Number.isFinite(retail) ? round2(retail) : null,
        });
      }
    }

    const cleaned = [...mapByCode.values()];
    console.log(`✅ Rows received: ${raw.length}`);
    console.log(`✅ Rows usable (valid code + price): ${cleaned.length}`);

    // 2) Prefetch Product.sku for those quadratec_code values (chunked)
    console.time("fetch products mapping");
    const codeToSku = new Map();
    const codeToSkuQuadratecBrandOnly = new Map();
    const codes = cleaned.map((x) => x.quadratec_code);

    for (const codeChunk of chunk(codes, 5000)) {
      const products = await prisma.product.findMany({
        where: { quadratec_code: { in: codeChunk } },
        select: { sku: true, quadratec_code: true },
      });
      for (const p of products) {
        if (p.quadratec_code) {
          codeToSku.set(p.quadratec_code, p.sku);
          if ((p.sku || "").toUpperCase().startsWith("QTC-")) {
            codeToSkuQuadratecBrandOnly.set(p.quadratec_code, p.sku);
          }
        }
      }
    }
    console.timeEnd("fetch products mapping");

    // 3) Build VendorProduct rows (only when we have a matching Product)
    const rowsToInsert = [];
    let missingProduct = 0;

    for (const r of cleaned) {
      const sku = r.quadratec_brand_only_match
        ? codeToSkuQuadratecBrandOnly.get(r.quadratec_code)
        : codeToSku.get(r.quadratec_code);
      if (!sku) {
        missingProduct++;
        continue;
      }

      rowsToInsert.push({
        product_sku: sku,
        vendor_id: VENDOR_ID,
        vendor_sku: r.quadratec_code,
        vendor_cost_usd: r.vendor_cost_usd,
        vendor_cost: r.vendor_cost,
        vendor_retail_price_usd: r.vendor_retail_price_usd,
        quadratec_sku: r.quadratec_sku,
      });
    }

    console.log(`✅ Rows with matching Product: ${rowsToInsert.length}`);
    console.log(`⚠️ Rows skipped (no Product match): ${missingProduct}`);

    // 4) Full refresh (fast)
    console.time("delete old vendor_id=4");
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } });
    console.timeEnd("delete old vendor_id=4");

    // 5) Insert in batches with progress
    console.time("insert vendorProducts");
    const start = Date.now();

    for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
      const batch = rowsToInsert.slice(i, i + BATCH_SIZE);

      await prisma.vendorProduct.createMany({
        data: batch,
      });

      const done = Math.min(i + BATCH_SIZE, rowsToInsert.length);
      const elapsed = (Date.now() - start) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const remaining = rowsToInsert.length - done;
      const eta = remaining / Math.max(rate, 0.001);

      // Progress log every batch
      console.log(
        `Batch ${Math.ceil(done / BATCH_SIZE)}/${Math.ceil(rowsToInsert.length / BATCH_SIZE)} | ` +
          `${done}/${rowsToInsert.length} rows | ` +
          `${rate.toFixed(1)} rows/s | ETA ~${Math.round(eta)}s`
      );
    }

    console.timeEnd("insert vendorProducts");

    const count = await prisma.vendorProduct.count({
      where: { vendor_id: 4 },
    });
    console.log(
      "✅ VendorProduct count for Quadratec (vendor_id=4):",
      count
    );
    
    console.log("✅ Quadratec vendor products seeded successfully.");
  } catch (error) {
    console.error("❌ Error seeding vendor products from Quadratec:", error);
  } finally {
    await prisma.$disconnect();
    console.timeEnd("seed-quadratec total");
  }
}

seedQuadratec();
module.exports = seedQuadratec;



// const prisma = require("../../../lib/prisma");
// const quadratecCost = require("../api-calls/quadratec-excel.js");

// // // seed Quadratec products
// const seedQuadratec = async () => {
//   try {
//     // Call QuadratecAPI and get the processed responses
//     const vendorProductsData = await quadratecCost();
//     let vendorProductCreatedCount = 0;
//     let vendorProductUpdatedCount = 0;

//     // // ✅ Step 0: Clear old vendor products for Quadratec
//     // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 4 } });
//     // console.log("🗑️ Deleted all existing Quadratec vendor products (vendor_id = 4)");

//     // Loop through the vendorProductsData array and create vendor products (batched)
//     const BATCH_SIZE = 100;
//     for (let batchStart = 0; batchStart < vendorProductsData.length; batchStart += BATCH_SIZE) {
//       const batch = vendorProductsData.slice(batchStart, batchStart + BATCH_SIZE);

//       for (const data of batch) {
//         // console.log("data", data);

//         try {
//           // Check if a vendor product with the same vendor_sku already exists

//           // 1) lookup scoped by vendor
//           const existingVendorProduct = await prisma.vendorProduct.findFirst({
//             where: {
//               vendor_id: 4,                 // Quadratec
//               vendor_sku: data.quadratec_code,
//             },
//           });

//           if (existingVendorProduct) {
//             vendorProductUpdatedCount++;
//             console.log(`[Quadratec] ${data.quadratec_code} exists for vendor_id=4, updating...`);
//             await prisma.vendorProduct.update({
//               where: { id: existingVendorProduct.id },   // << use the SAME var
//               data: {
//                 vendor_id: 4,                            // reassert (safe)
//                 vendor_sku: data.quadratec_code,
//                 vendor_cost: +(data.wholesalePrice * 1.5).toFixed(2),
//                 quadratec_sku: data.quadratec_sku,
//               },
//             });
//             continue;
//           }


//       // if (existingCompetitorProduct) {
//       //   vendorProductUpdatedCount++;
//       //   // console.log(
//       //   //   `Vendor product with vendor_sku: ${data['Part Number']} already exists, updating...`
//       //   // );
//       //   console.log(`Vendor product with vendor_sku: ${data.quadratec_code} already exists, updating...`);

//       //   // Update the existing vendor product with new data
//       //   await prisma.vendorProduct.update({
//       //     where: {
//       //       id: existingCompetitorProduct.id, // assuming there's an 'id' field as the primary key
//       //     },
//       //     data: {
//       //       vendor_sku: data.quadratec_code, // Update with new vendor_sku
//       //       vendor_cost: data.wholesalePrice * 1.5, // Update with new vendor_cost
//       //       quadratec_sku: data.quadratec_sku, // Update with new quadratec_sku
//       //       // Add any other fields that you want to update
//       //     },
//       //   });

//       //   // console.log(
//       //   //   `Vendor product with vendor_sku: ${data['Part Number']} updated successfully`
//       //   // );
//       //   continue; // Move to next iteration
//       // }

//       // Retrieve the product_sku from the Product table using meyer_code as reference
//       let product; // Update: Declare product variable here
//           product = await prisma.product.findFirst({
//             where: {
//               quadratec_code: data.quadratec_code, // Update: Access 'Part Number' key from data object
//             },
//           });
//       // console.log("product", product);

//           if (!product) {
//             continue;
//           }

//       // Update the data with the retrieved product_sku and vendor_id

//       //   const hasNoInventoryInfo =
//       //   (data.vendor_inventory === null || data.vendor_inventory === undefined) &&
//       //   !data.vendor_inventory_string;
      
//       //   const vendorProductData = {
//       //     product_sku: product.sku,
//       //     vendor_id: 4,
//       //     vendor_sku: data.quadratec_code,
//       //     vendor_cost: data.wholesalePrice * 1.5,
//       //     quadratec_sku: data.quadratec_sku,
//       //     vendor_inventory: data.vendor_inventory,
//       //     vendor_inventory_string: hasNoInventoryInfo ? "no info" : data.vendor_inventory_string,
//       // };
    

//           const vendorProductData = {
//             product_sku: product.sku, // Updated with the correct product SKU',
//             vendor_id: 4, // Updated with the correct vendor ID
//             vendor_sku: data.quadratec_code, // Extracted from API response
//             //2 decimal places for vendor_cost
//             vendor_cost: data.wholesalePrice * 1.5, // Extracted from API response
//             // vendor_cost: data.wholesalePrice*1.40, // Extracted from API response
//             quadratec_sku: data.quadratec_sku, // Update with new quadratec_sku
//             // Add any other fields that you want to create
//           };

      

//       // Create the vendor product
//           await prisma.vendorProduct.create({
//             data: vendorProductData,
//           });
//           vendorProductCreatedCount++;
//           console.log(`[Quadratec] ${data.quadratec_code} created for vendor_id=4`);
//         } catch (itemError) {
//           console.error(`Error processing Quadratec SKU ${data?.quadratec_code}:`, itemError.message || itemError);
//         }
//       }

//       // Small delay between batches to avoid connection pool exhaustion
//       if (batchStart + BATCH_SIZE < vendorProductsData.length) {
//         await new Promise((resolve) => setTimeout(resolve, 100));
//       }
//     }

//     // console.log("Vendor products from Quadratec seeded successfully!");
//     // console.log(`Total vendor products created: ${vendorProductCreatedCount}`);
//     // console.log(`Total vendor products updated: ${vendorProductUpdatedCount}`);
//     console.log(`Vendor products from Quadratec seeded successfully! 
//       Total vendor products created: ${vendorProductCreatedCount}, 
//       Total vendor products updated: ${vendorProductUpdatedCount}`);
//   } catch (error) {
//     console.error("Error seeding vendor products from Quadratec:", error);
//   } finally {
//     await prisma.$disconnect();
//   }
// };

// seedQuadratec();
// module.exports = seedQuadratec;
