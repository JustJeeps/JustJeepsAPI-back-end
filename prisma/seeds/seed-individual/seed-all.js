#!/usr/bin/env node
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../../");
const logsDir = path.resolve(ROOT, "prisma/seeds/logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// sequential pairs
const vendorSeeds = [
  { main: "seed-quadratec",   dependent: "seed-quad-inventory" },
  { main: "seed-omix",        dependent: "seed-omix-inventory" },
  { main: "seed-wheelPros",   dependent: "seed-wp-inventory" },
  // Keep Keystone pair if you want FTP→API ordering
  { main: "seed-keystone-ftp2", dependent: "seed-keystone-ftp-codes" },
];

// parallel tails
const otherSeeds = [
  "seed-roughCountry",
  "seed-tireDiscounter",
  "seed-aev",
  "seed-ctp",
  "seed-keyparts",
  "seed-alpine",
  "seed-meyer",
  "seed-tdot",
  "seed-lowriders",
  // "seed-daily-turn14-production", // Daily Turn14 pricing/inventory updates
  "seed-turn14-production"
];

const RUN_CODES_AFTER_VENDORS = false; // flip to true if you want a final pass

function runCommandToLog(cmd) {
  return new Promise((resolve, reject) => {
    console.log(`🚀 Starting: ${cmd}`);
    const logFile = path.join(logsDir, `${cmd}.log`);
    const child = exec(`npm run ${cmd} > "${logFile}" 2>&1`, { cwd: ROOT });
    child.on("exit", code => {
      if (code === 0) {
        console.log(`✅ Finished: ${cmd} (log: prisma/seeds/logs/${path.basename(logFile)})`);
        resolve();
      } else {
        console.log(`❌ Failed: ${cmd} (see prisma/seeds/logs/${path.basename(logFile)})`);
        reject(new Error(`Seed failed: ${cmd}`));
      }
    });
  });
}

(async () => {
  try {
    // 1) Products first (provides keystone_ftp_brand + searchableSku)
    console.log("🔹 Running seed-allProducts...");
    await runCommandToLog("seed-allProducts");

    // 2) Fix keystone codes/site prefixes based on FTP + vendors_prefix aliases
    console.log("🔹 Running seed-keystone-ftp-codes...");
    await runCommandToLog("seed-keystone-ftp-codes");

    // 3) Vendor pairs sequentially
    console.log("\n🔹 Running vendor seeds with dependencies...");
    for (const g of vendorSeeds) {
      await runCommandToLog(g.main);
      await runCommandToLog(g.dependent);
    }

    // 4) Others in parallel
    console.log("\n🔹 Running remaining seeds in parallel...");
    await Promise.allSettled(otherSeeds.map(runCommandToLog));

    // 5) Optional final pass to re-sync codes/site after vendor seeds
    if (RUN_CODES_AFTER_VENDORS) {
      console.log("\n🔹 Final sync: seed-keystone-ftp-codes...");
      await runCommandToLog("seed-keystone-ftp-codes");
    }

    console.log("\n🎉 All seeding scripts finished (check logs for details).");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error during seeding pipeline:", err.message);
    process.exit(1);
  }
})();


// const { exec } = require("child_process");
// const path = require("path");
// const fs = require("fs");

// // ✅ Ensure logs folder exists
// const logsDir = path.resolve(__dirname, "../../logs");
// if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// // ✅ Groups: seeds with dependencies
// const vendorSeeds = [
//   { main: "seed-quadratec", dependent: "seed-quad-inventory" },
//   { main: "seed-omix", dependent: "seed-omix-inventory" },
//   { main: "seed-wheelPros", dependent: "seed-wp-inventory" },
//   // { main: "seed-keystone-ftp", dependent: "seed-keystone" } // ✅ NEW: Keystone /FTP before Keystone

// ];

// // ✅ Other independent seeds
// const otherSeeds = [
//   "seed-roughCountry",
//   "seed-tireDiscounter",
//   "seed-aev",
//   "seed-ctp",
//   "seed-keyparts",
//   "seed-alpine",
//   "seed-meyer",
//   // "seed-keystone",
//   // "seed-keystone-ftp",
//   "seed-tdot",
//   "seed-lowriders",
//   "seed-keystone-ftp-codes",
// ];

// // ✅ Run command and save logs
// function runCommandToLog(cmd) {
//   return new Promise((resolve, reject) => {
//     console.log(`🚀 Starting: ${cmd}`);
//     const logFile = path.join(logsDir, `${cmd}.log`);
//     const child = exec(`npm run ${cmd} > "${logFile}" 2>&1`, {
//       cwd: path.resolve(__dirname, "../../")
//     });

//     child.on("exit", code => {
//       if (code === 0) {
//         console.log(`✅ Finished: ${cmd} (log: logs/${cmd}.log)`);
//         resolve();
//       } else {
//         console.log(`❌ Failed: ${cmd} (check logs/${cmd}.log)`);
//         reject(new Error(`Seed failed: ${cmd}`));
//       }
//     });
//   });
// }

// (async () => {
//   try {
//     console.log("🔹 Running seed-allProducts (sequential step)...");
//     await runCommandToLog("seed-allProducts");

//     console.log("\n🔹 Running vendor seeds with dependencies...");
//     for (const group of vendorSeeds) {
//       await runCommandToLog(group.main);
//       await runCommandToLog(group.dependent);
//     }

//     console.log("\n🔹 Running remaining seeds in parallel...");
//     await Promise.allSettled(otherSeeds.map(seed => runCommandToLog(seed)));

//     console.log("\n🎉 All seeding scripts finished (check logs for details).");
//   } catch (err) {
//     console.error("❌ Error during seeding:", err.message);
//     process.exit(1);
//   }
// })();


