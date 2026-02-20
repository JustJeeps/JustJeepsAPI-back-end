/**
 * Seed Quadratec inventory (90k rows friendly)
 * - Bulk updates VendorProduct.vendor_inventory using a TEMP table + join update
 * - Runs inside ONE transaction so TEMP table exists (single connection)
 * - Dedupes duplicates within each batch to avoid Postgres 21000 error
 * - Adds transaction timeout so Prisma doesn't close it mid-run (P2028)
 */

const prisma = require("../../../lib/prisma");
const quadratecInventory = require("../api-calls/quad-inventory-api");

const VENDOR_ID = 4;
const BATCH_SIZE = 1000;         // you can increase later (2000-5000)
const LOG_EVERY_BATCH = 5;

// Prisma interactive transaction settings (IMPORTANT)
const TX_OPTIONS = {
  maxWait: 60_000,     // how long Prisma waits to acquire a connection
  timeout: 600_000,    // how long the interactive transaction can run (10 min)
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function formatTime(sec) {
  if (!Number.isFinite(sec)) return "?";
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

async function seedQuadInventoryBulk() {
  console.time("seed-quad-inventory total");

  try {
    console.time("fetch inventory");
    const rows = await quadratecInventory();
    console.timeEnd("fetch inventory");

    // DO NOT log the full rows array (kills runtime)
    console.log(`✅ Rows received: ${rows.length}`);

    const cleaned = rows
      .flatMap((r) => {
        const inv = r?.quadratec_inventory;
        const codes = [r?.quadratec_code, r?.quadratec_code_alt]
          .map((value) => (value ?? "").trim())
          .filter(Boolean);

        if (!codes.length) return [];
        return codes.map((code) => ({ code, inv }));
      })
      .filter((r) => r.code && r.inv !== undefined && r.inv !== null);

    console.log(`✅ Rows usable (code + inventory): ${cleaned.length}`);

    const batches = chunk(cleaned, BATCH_SIZE);
    const start = Date.now();

    await prisma.$transaction(
      async (tx) => {
        // TEMP table must be created inside the SAME connection/session
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE temp_quad_inv (
            vendor_sku TEXT PRIMARY KEY,
            vendor_inventory DOUBLE PRECISION
          ) ON COMMIT DROP;
        `);

        for (let b = 0; b < batches.length; b++) {
          const batch = batches[b];

          // Deduplicate within this batch (prevents Postgres 21000)
          const dedup = new Map();
          for (const r of batch) {
            if (!r?.code) continue;
            dedup.set(r.code, r.inv); // keep last one
          }

          await tx.$executeRawUnsafe(`TRUNCATE TABLE temp_quad_inv;`);

          const entries = [...dedup.entries()];
          if (entries.length === 0) continue;

          const valuesSql = entries
            .map(([code, inv]) => {
              const safeSku = String(code).replace(/'/g, "''");
              const safeInv = Number.isFinite(Number(inv)) ? Number(inv) : 0;
              return `('${safeSku}', ${safeInv})`;
            })
            .join(",\n");

          // No ON CONFLICT needed because we truncated the temp table
          await tx.$executeRawUnsafe(`
            INSERT INTO temp_quad_inv (vendor_sku, vendor_inventory)
            VALUES
            ${valuesSql};
          `);

          await tx.$executeRawUnsafe(`
            UPDATE "VendorProduct" vp
            SET vendor_inventory = t.vendor_inventory
            FROM temp_quad_inv t
            WHERE vp.vendor_id = ${VENDOR_ID}
              AND vp.vendor_sku = t.vendor_sku;
          `);

          // Progress / ETA
          if ((b + 1) % LOG_EVERY_BATCH === 0 || b === batches.length - 1) {
            const done = Math.min((b + 1) * BATCH_SIZE, cleaned.length);
            const elapsedSec = (Date.now() - start) / 1000;
            const rate = done / Math.max(elapsedSec, 0.001);
            const remaining = cleaned.length - done;
            const etaSec = remaining / Math.max(rate, 0.001);

            console.log(
              `Batch ${b + 1}/${batches.length} | ` +
                `${done}/${cleaned.length} rows | ` +
                `${rate.toFixed(1)} rows/s | ETA ~${formatTime(etaSec)}`
            );
          }
        }
      },
      TX_OPTIONS
    );

    console.log("✅ Quad inventory completed.");
  } catch (e) {
    console.error("❌ Error updating Quad inventory:", e);
  } finally {
    console.timeEnd("seed-quad-inventory total");
    await prisma.$disconnect();
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
