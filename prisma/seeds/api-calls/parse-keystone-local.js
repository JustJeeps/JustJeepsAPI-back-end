/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

// Normalize a code the way your DB expects it
function normalizeVcPnForDB(code) {
  if (code == null) return "";
  return String(code).trim().replace(/\s+/g, "").toUpperCase();
}

// Clean Excel-ish strings like ="800110"
function clean(s) {
  if (s == null) return "";
  let t = String(s).trim();
  if (/^=\s*".*"$/.test(t)) t = t.replace(/^=\s*"(.*)"$/, "$1"); // ="123" -> 123
  return t.replace(/^"+|"+$/g, "").trim();
}

// Numeric helpers
function toFloatOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}
function toInt(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Reads Inventory.csv and SpecialOrder.csv from dirAbsolutePath and
 * outputs unified objects:
 *   {
 *     vcPn,                    // Keystone code (VCPN)
 *     vendorCode,              // e.g., TER
 *     vendorName,              // e.g., TERAFLEX
 *     partNumber,              // vendor's part number (not MPN)
 *     manufacturerPartNo,      // ManufacturerPartNo / MPN
 *     cost, totalQty
 *   }
 * Also logs a per-file VCPN extraction summary (direct vs derived vs empty).
 */
async function parseKeystoneLocal(dirAbsolutePath) {
  const files = [
    { name: "Inventory", file: "Inventory.csv" },
    { name: "SpecialOrder", file: "SpecialOrder.csv" },
  ];

  const debugTotals = [];

  const parseOne = (absPath) =>
    new Promise((resolve) => {
      if (!fs.existsSync(absPath)) {
        console.warn(`⚠️ File not found: ${absPath} — skipping`);
        return resolve([]);
      }

      const rows = [];
      let haveVCPN = 0;
      let builtFromVendorPart = 0;
      let emptyVCPN = 0;

      fs.createReadStream(absPath)
        .pipe(csv())
        .on("data", (raw) => {
          const get = (...keys) => {
            for (const k of keys) {
              if (raw[k] !== undefined) return String(raw[k]).trim();
            }
            return "";
          };

          // Common Keystone headers
          const vendorCode = clean(get("VendorCode", "Vendor Code", "Vendor", "VENDOR"));

          // NEW: vendorName + manufacturerPartNo kept separately
          const vendorName = clean(
            get("VendorName", "Vendor Name", "Brand", "Manufacturer")
          );
          const manufacturerPartNo = clean(
            get(
              "ManufacturerPartNo",
              "Manufacturer Part No",
              "Manufacturer Part Number",
              "ManufacturerPartNumber",
              "MfrPartNo",
              "Mfr Part #",
              "MPN"
            )
          );

          // PartNumber should remain the vendor's part number (not the MPN)
          const partNumber = clean(
            get("PartNumber", "Part Number", "PARTNUMBER", "PartNo", "Part #", "PN")
          );

          // Keystone code (VCPN) may be present or derivable
          let vcPn = clean(get("vcPn", "VCPN", "VcPn", "KeystonePN", "KeystoneCode", "Keystone_Code"));

          // Derive VCPN if missing: VendorCode + PartNumber
          if (!vcPn) {
            if (vendorCode && partNumber) {
              vcPn = normalizeVcPnForDB(`${vendorCode}${partNumber}`);
              if (vcPn) builtFromVendorPart++;
              else emptyVCPN++;
            } else {
              emptyVCPN++;
            }
          } else {
            vcPn = normalizeVcPnForDB(vcPn);
            haveVCPN++;
          }

          // Prices/Qty with broad aliases
          const costStr = get(
            "Cost", "cost", "CustomerPrice", "JobberPrice", "Price", "UnitPrice", "Your Cost", "YourCost"
          );
          const qtyStr = get(
            "TotalQty", "totalQty", "Total Qty", "Qty", "Quantity", "QtyAvailable", "Available",
            "EastQty","MidwestQty","CaliforniaQty","SoutheastQty","PacificNWQty","TexasQty","GreatLakesQty","FloridaQty"
          );

          // If TotalQty missing but regional columns exist, sum them
          let totalQty = toInt(qtyStr);
          if (!qtyStr) {
            const regions = [
              "EastQty","MidwestQty","CaliforniaQty","SoutheastQty","PacificNWQty","TexasQty","GreatLakesQty","FloridaQty"
            ];
            let sum = 0;
            let sawRegion = false;
            for (const r of regions) {
              if (raw[r] !== undefined) {
                sum += toInt(raw[r]);
                sawRegion = true;
              }
            }
            if (sawRegion) totalQty = sum;
          }

          const cost = toFloatOrNull(costStr);

          if (!vcPn) return; // still no key? skip line

          rows.push({
            vcPn,
            vendorCode,
            vendorName,          // <-- added
            partNumber,
            manufacturerPartNo,  // <-- added
            cost,
            totalQty,
          });
        })
        .on("end", () => {
          debugTotals.push({
            file: path.basename(absPath),
            rows: rows.length,
            haveVCPN,
            builtFromVendorPart,
            emptyVCPN,
          });
          resolve(rows);
        })
        .on("error", () => resolve([]));
    });

  const results = [];
  for (const f of files) {
    const abs = path.resolve(dirAbsolutePath, f.file);
    const data = await parseOne(abs);
    results.push({ name: f.name, data });
  }

  console.log("🧪 VCPN extraction summary per file:", debugTotals);
  return results;
}

module.exports = parseKeystoneLocal;


// /* eslint-disable no-console */
// const fs = require("fs");
// const path = require("path");
// const csv = require("csv-parser");

// // Normalize a code the way your DB expects it
// function normalizeVcPnForDB(code) {
//   if (code == null) return "";
//   return String(code).trim().replace(/\s+/g, "").toUpperCase();
// }

// // Clean Excel-ish strings like ="800110"
// function clean(s) {
//   if (s == null) return "";
//   let t = String(s).trim();
//   if (/^=\s*".*"$/.test(t)) t = t.replace(/^=\s*"(.*)"$/, "$1"); // ="123" -> 123
//   return t.replace(/^"+|"+$/g, "").trim();
// }

// // Numeric helpers
// function toFloatOrNull(v) {
//   if (v === null || v === undefined || v === "") return null;
//   const n = parseFloat(String(v).replace(/,/g, ""));
//   return Number.isNaN(n) ? null : n;
// }
// function toInt(v) {
//   if (v === null || v === undefined || v === "") return 0;
//   const n = parseInt(String(v).replace(/,/g, ""), 10);
//   return Number.isNaN(n) ? 0 : n;
// }

// /**
//  * Reads Inventory.csv and SpecialOrder.csv from dirAbsolutePath and
//  * outputs unified objects: { vcPn, partNumber, cost, totalQty }
//  * Also logs a per-file VCPN extraction summary (direct vs derived vs empty).
//  */
// async function parseKeystoneLocal(dirAbsolutePath) {
//   const files = [
//     { name: "Inventory", file: "Inventory.csv" },
//     { name: "SpecialOrder", file: "SpecialOrder.csv" },
//   ];

//   const debugTotals = [];

//   const parseOne = (absPath) =>
//     new Promise((resolve) => {
//       if (!fs.existsSync(absPath)) {
//         console.warn(`⚠️ File not found: ${absPath} — skipping`);
//         return resolve([]);
//       }

//       const rows = [];
//       let haveVCPN = 0;
//       let builtFromVendorPart = 0;
//       let emptyVCPN = 0;

//       fs.createReadStream(absPath)
//         .pipe(csv())
//         .on("data", (raw) => {
//           const get = (...keys) => {
//             for (const k of keys) {
//               if (raw[k] !== undefined) return String(raw[k]).trim();
//             }
//             return "";
//           };

//           // Common Keystone headers
//           const vendorCode = clean(get("VendorCode", "Vendor Code", "Vendor", "VENDOR"));
//           const partNumber = clean(
//             get("PartNumber", "Part Number", "PARTNUMBER", "PartNo", "Part #", "PN", "ManufacturerPartNo")
//           );

//           let vcPn = clean(get("vcPn", "VCPN", "VcPn", "KeystonePN", "KeystoneCode", "Keystone_Code"));

//           // Derive VCPN if missing: VendorCode + PartNumber
//           if (!vcPn) {
//             if (vendorCode && partNumber) {
//               vcPn = normalizeVcPnForDB(`${vendorCode}${partNumber}`);
//               if (vcPn) builtFromVendorPart++;
//               else emptyVCPN++;
//             } else {
//               emptyVCPN++;
//             }
//           } else {
//             vcPn = normalizeVcPnForDB(vcPn);
//             haveVCPN++;
//           }

//           // Prices/Qty with broad aliases
//           const costStr = get(
//             "Cost", "cost", "CustomerPrice", "JobberPrice", "Price", "UnitPrice", "Your Cost", "YourCost"
//           );
//           const qtyStr = get(
//             "TotalQty", "totalQty", "Total Qty", "Qty", "Quantity", "QtyAvailable", "Available",
//             "EastQty","MidwestQty","CaliforniaQty","SoutheastQty","PacificNWQty","TexasQty","GreatLakesQty","FloridaQty"
//           );

//           // If TotalQty missing but regional columns exist, sum them
//           let totalQty = toInt(qtyStr);
//           if (!qtyStr) {
//             const regions = [
//               "EastQty","MidwestQty","CaliforniaQty","SoutheastQty","PacificNWQty","TexasQty","GreatLakesQty","FloridaQty"
//             ];
//             let sum = 0;
//             let sawRegion = false;
//             for (const r of regions) {
//               if (raw[r] !== undefined) {
//                 sum += toInt(raw[r]);
//                 sawRegion = true;
//               }
//             }
//             if (sawRegion) totalQty = sum;
//           }

//           const cost = toFloatOrNull(costStr);

//           if (!vcPn) return; // still no key? skip line

//           rows.push({
//             vcPn,
//             partNumber, // kept for reference
//             cost,
//             totalQty,
//           });
//         })
//         .on("end", () => {
//           debugTotals.push({
//             file: path.basename(absPath),
//             rows: rows.length,
//             haveVCPN,
//             builtFromVendorPart,
//             emptyVCPN,
//           });
//           resolve(rows);
//         })
//         .on("error", () => resolve([]));
//     });

//   const results = [];
//   for (const f of files) {
//     const abs = path.resolve(dirAbsolutePath, f.file);
//     const data = await parseOne(abs);
//     results.push({ name: f.name, data });
//   }

//   console.log("🧪 VCPN extraction summary per file:", debugTotals);
//   return results;
// }

// module.exports = parseKeystoneLocal;
