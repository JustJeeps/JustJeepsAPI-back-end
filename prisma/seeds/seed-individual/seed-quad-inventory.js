/**
 * Seed Quadratec inventory (90k rows friendly)
 * Bulk update in batches using a temp table + join update
 */

const prisma = require("../../../lib/prisma");
const quadratecInventory = require("../api-calls/quad-inventory-api");

const VENDOR_ID = 4;
const BATCH_SIZE = 1000;      // 1000–5000 are common; start with 1000 for safety
const LOG_EVERY_BATCH = 5;    // log every 5 batches
const RETRIES = 5;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runWithRetry(fn, label = "sql", tries = RETRIES) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e?.code !== "P1017") throw e;

      console.warn(`⚠️ ${label} failed (P1017). Retry ${i}/${tries}...`);
      try { await prisma.$disconnect(); } catch {}
      try { await prisma.$connect(); } catch {}
      await sleep(400 * i);
    }
  }
  throw last;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function seedQuadInventoryBulk() {
  console.time("seed-quad-inventory total");

  try {
    await prisma.$connect();

    console.time("fetch inventory");
    const rows = await quadratecInventory();
    console.timeEnd("fetch inventory");

    const cleaned = rows
      .map(r => ({
        code: r?.quadratec_code,
        inv: r?.quadratec_inventory,
      }))
      .filter(r => r.code && r.inv !== undefined && r.inv !== null);

    console.log(`✅ Rows received: ${rows.length}`);
    console.log(`✅ Rows usable (code + inventory): ${cleaned.length}`);

    const batches = chunk(cleaned, BATCH_SIZE);
    const start = Date.now();

    // Temp table for batch updates (drops automatically at end of session)
    await runWithRetry(
      () => prisma.$executeRawUnsafe(`
        CREATE TEMP TABLE IF NOT EXISTS temp_quad_inv (
          vendor_sku TEXT PRIMARY KEY,
          vendor_inventory INT
        ) ON COMMIT DROP;
      `),
      "create temp table"
    );

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      await runWithRetry(
        () => prisma.$executeRawUnsafe(`TRUNCATE TABLE temp_quad_inv;`),
        "truncate temp"
      );

      // Build VALUES list (safe enough if vendor_sku is normal text; we escape single quotes)
      const valuesSql = batch
        .map(r => {
          const safeSku = String(r.code).replace(/'/g, "''");
          const safeInv = Number.isFinite(Number(r.inv)) ? Number(r.inv) : 0;
          return `('${safeSku}', ${safeInv})`;
        })
        .join(",\n");

      await runWithRetry(
        () => prisma.$executeRawUnsafe(`
          INSERT INTO temp_quad_inv (vendor_sku, vendor_inventory)
          VALUES
          ${valuesSql}
          ON CONFLICT (vendor_sku) DO UPDATE
          SET vendor_inventory = EXCLUDED.vendor_inventory;
        `),
        `insert temp batch ${b + 1}/${batches.length}`
      );

      // ✅ Use the exact table name VendorProduct
      await runWithRetry(
        () => prisma.$executeRawUnsafe(`
          UPDATE "VendorProduct" vp
          SET vendor_inventory = t.vendor_inventory
          FROM temp_quad_inv t
          WHERE vp.vendor_id = ${VENDOR_ID}
            AND vp.vendor_sku = t.vendor_sku;
        `),
        `bulk update batch ${b + 1}/${batches.length}`
      );

      if ((b + 1) % LOG_EVERY_BATCH === 0 || b === batches.length - 1) {
        const done = Math.min((b + 1) * BATCH_SIZE, cleaned.length);
        const elapsedSec = (Date.now() - start) / 1000;
        const rate = done / Math.max(elapsedSec, 0.001);
        const remaining = cleaned.length - done;
        const etaMin = Math.round((remaining / Math.max(rate, 0.01)) / 60);

        console.log(
          `Batch ${b + 1}/${batches.length} | ` +
          `${done}/${cleaned.length} rows | ` +
          `${rate.toFixed(1)} rows/s | ETA ~${etaMin} min`
        );
      }
    }

    console.log(`✅ Quad inventory completed.`);
  } catch (e) {
    console.error("❌ Error updating Quad inventory:", e);
  } finally {
    await prisma.$disconnect();
    console.timeEnd("seed-quad-inventory total");
  }
}

seedQuadInventoryBulk();
module.exports = seedQuadInventoryBulk;




// const prisma = require('../../../lib/prisma');
// const quadratecInventory = require('../api-calls/quad-inventory-api');

// async function seedQuadInventory() {
//   try {
//     const inventoryData = await quadratecInventory();

//     for (const data of inventoryData) {
//       if (!data.quadratec_code) {
//         console.warn(`Skipping entry with missing quadratec_code:`, data);
//         continue;
//       }

//       const existingProduct = await prisma.vendorProduct.findFirst({
//         where: {
//           vendor_sku: data.quadratec_code,
//           vendor_id: 4
//         }
//       });

//       // if (existingProduct) {
//       //   const hasNoInventoryInfo =
//       //   (data.quadratec_inventory === null || data.quadratec_inventory === undefined) &&
//       //   !data.vendor_inventory_string;
      
//       //   const vendorInventoryString = hasNoInventoryInfo ? "no info" : data.vendor_inventory_string;
      
      
//       //   await prisma.vendorProduct.update({
//       //     where: { id: existingProduct.id },
//       //     data: {
//       //       vendor_inventory: data.quadratec_inventory,
//       //       vendor_inventory_string: vendorInventoryString,
//       //     },
//       //   });
      
//       //   console.log(
//       //     `Updated inventory for vendor_sku: ${data.quadratec_code} | Inventory: ${data.quadratec_inventory} | Inventory String: ${vendorInventoryString}`
//       //   );
//       // }
      

//       if (existingProduct) {
//         await prisma.vendorProduct.update({
//           where: { id: existingProduct.id },
//           data: {
//             vendor_inventory: data.quadratec_inventory,
//           }
//         });
//         console.log(`Updated inventory for vendor_sku: ${data.quadratec_code}`);
//       } else {
//         // console.warn(`No existing product found for vendor_sku: ${data.quadratec_code}`);
//       }
//     }

//     console.log('Quad inventory seeding completed.');
//   } catch (error) {
//     console.error('Error updating inventory:', error);
//   } finally {
//     await prisma.$disconnect();
//   }
// }

// seedQuadInventory();
// module.exports = seedQuadInventory;
