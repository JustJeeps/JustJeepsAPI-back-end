#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../../../");
const logsDir = path.resolve(ROOT, "prisma/seeds/logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// sequential pairs
const vendorSeeds = [
  { main: "seed-quadratec",   dependent: "seed-quad-inventory" },
  { main: "seed-omix",        dependent: "seed-omix-inventory" },
  // { main: "seed-keystone-ftp2", dependent: "seed-keystone-ftp-codes" },
  { main: "seed-wheelPros",   dependent: "seed-wp-inventory" },
  // Keep Keystone pair if you want FTP→API ordering
];

// parallel tails
const otherSeeds = [
  
  "seed-orders-all",
  "seed-meyer",
  "seed-tdot",
  // "seed-roughCountry",
  "seed-tireDiscounter",
  // "seed-aev",
  // "seed-ctp",
  // "seed-keyparts",
  // "seed-alpine",

  // "seed-lowriders",
  // "seed-daily-turn14-production", // Daily Turn14 pricing/inventory updates
  // "seed-turn14-production"
  "magento-attributes-priority"
];

const RUN_CODES_AFTER_VENDORS = false; // flip to true if you want a final pass

const jobName = "Daily Vendor Sync (seed-all)";
const summaryPath = path.join(logsDir, "seed-all-summary.json");
const lockPath = path.join(logsDir, "seed-all.lock");
const SEED_TIMEOUT_MS = parseDuration(process.env.SEED_TIMEOUT || "10h", 4 * 60 * 60 * 1000);
const LOCK_STALE_MS = parseDuration(process.env.SEED_LOCK_MAX_AGE || "24h", 24 * 60 * 60 * 1000);
const KILL_GRACE_MS = 10000;

function parseDuration(value, fallbackMs) {
  if (!value) return fallbackMs;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  const match = text.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  switch (unit) {
    case "h":
      return amount * 60 * 60 * 1000;
    case "m":
      return amount * 60 * 1000;
    case "s":
      return amount * 1000;
    case "ms":
    default:
      return amount;
  }
}

function formatDateTime(date) {
  return date.toISOString();
}

function formatDuration(durationMs) {
  if (durationMs == null) return "n/a";
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = durationMs % 1000;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  parts.push(`${millis}ms`);
  return parts.join(" ");
}

function runCommandToLog(cmd) {
  return new Promise((resolve) => {
    const start = Date.now();
    const startedAt = new Date(start);
    console.log(`🚀 Starting: ${cmd} @ ${formatDateTime(startedAt)}`);
    const logFile = path.join(logsDir, `${cmd}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    const child = spawn("npm", ["run", cmd], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.stdout) child.stdout.pipe(logStream);
    if (child.stderr) child.stderr.pipe(logStream);

    let settled = false;
    let timedOut = false;

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      logStream.end();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      const message = `⏰ Timeout: ${cmd} exceeded ${formatDuration(SEED_TIMEOUT_MS)}`;
      console.log(message);
      logStream.write(`${message}\n`);
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, SEED_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - start;
      const finishedAt = new Date();
      const durationText = formatDuration(durationMs);

      if (timedOut) {
        console.log(`❌ Timed out: ${cmd} @ ${formatDateTime(finishedAt)} (${durationText})`);
        return finalize({
          cmd,
          success: false,
          code,
          logFile,
          durationMs,
          error: `Timeout after ${formatDuration(SEED_TIMEOUT_MS)}`,
        });
      }

      if (code === 0) {
        console.log(`✅ Finished: ${cmd} @ ${formatDateTime(finishedAt)} (${durationText}) (log: prisma/seeds/logs/${path.basename(logFile)})`);
        return finalize({ cmd, success: true, code, logFile, durationMs });
      }

      const errorText = signal ? `Signal ${signal}` : `Exit code ${code}`;
      console.log(`❌ Failed: ${cmd} @ ${formatDateTime(finishedAt)} (${durationText}) (see prisma/seeds/logs/${path.basename(logFile)})`);
      return finalize({ cmd, success: false, code, logFile, durationMs, error: errorText });
    });

    child.on("error", err => {
      clearTimeout(timeout);
      const durationMs = Date.now() - start;
      const finishedAt = new Date();
      const durationText = formatDuration(durationMs);
      console.log(`❌ Failed to start: ${cmd} @ ${formatDateTime(finishedAt)} (${durationText})`);
      finalize({ cmd, success: false, code: null, logFile, durationMs, error: err.message });
    });
  });
}

async function runCommandSafely(cmd) {
  try {
    return await runCommandToLog(cmd);
  } catch (err) {
    return {
      cmd,
      success: false,
      code: null,
      logFile: path.join(logsDir, `${cmd}.log`),
      durationMs: null,
      error: err && err.message ? err.message : 'Unknown error'
    };
  }
}

(async () => {
  const startTime = Date.now();
  const startedAt = new Date(startTime);
  const results = [];

  // ...lock file check removed as requested...

  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: startedAt.toISOString() }, null, 2)
  );

  try {
    console.log(`🕒 Job started @ ${formatDateTime(startedAt)}: ${jobName}`);
    // 1) Products first (provides keystone_ftp_brand + searchableSku)
    console.log("🔹 Running seed-allProducts...");
    results.push(await runCommandSafely("seed-allProducts"));

    // 2) Fix keystone codes/site prefixes based on FTP + vendors_prefix aliases
    console.log("🔹 Running seed-keystone-ftp-codes...");
    results.push(await runCommandSafely("seed-keystone-ftp-codes"));

    // 3) Vendor pairs sequentially
    console.log("\n🔹 Running vendor seeds with dependencies...");
    for (const g of vendorSeeds) {
      results.push(await runCommandSafely(g.main));
      if (g.pre) {
        results.push(await runCommandSafely(g.pre));
      }
      results.push(await runCommandSafely(g.dependent));
    }

    // 4) Others sequentially
    console.log("\n🔹 Running remaining seeds sequentially...");
    for (const seed of otherSeeds) {
      results.push(await runCommandSafely(seed));
    }

    // 5) Optional final pass to re-sync codes/site after vendor seeds
    if (RUN_CODES_AFTER_VENDORS) {
      console.log("\n🔹 Final sync: seed-keystone-ftp-codes...");
      results.push(await runCommandSafely("seed-keystone-ftp-codes"));
    }
  } catch (err) {
    console.error("❌ Unexpected error during seeding pipeline:", err.message);
  } finally {
    const durationMs = Date.now() - startTime;
    const finishedAt = new Date();
    const summary = {
      jobName,
      startedAt: new Date(startTime).toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      durationText: formatDuration(durationMs),
      results,
    };

    try {
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      console.log(`📄 Summary written to prisma/seeds/logs/${path.basename(summaryPath)}`);
    } catch (writeErr) {
      console.error("❌ Failed to write summary file:", writeErr.message);
    }

    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (lockErr) {
      console.error("❌ Failed to remove lock file:", lockErr.message);
    }

    const failedCount = results.filter(r => !r.success).length;
    if (failedCount > 0) {
      console.error(`⏱ Total execution time: ${formatDuration(durationMs)}`);
      console.error(`❌ ${failedCount} script(s) failed. See summary for details.`);
      process.exit(1);
    } else {
      console.log(`\n🎉 All seeding scripts finished successfully @ ${formatDateTime(finishedAt)} (total: ${formatDuration(durationMs)}) (check logs for details).`);
      process.exit(0);
    }
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


