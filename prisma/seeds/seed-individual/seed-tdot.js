// TDOT competitor prices: runner + unchanged upsert (DD-019). The acquisition
// lives in prisma/seeds/api-calls/tdot-api.js (Klevu collector, snapshot).
//
//   npm run seed-tdot                              # collect + write
//   npm run seed-tdot -- --dry-run                 # collect + match report, no writes
//   npm run seed-tdot -- --from-snapshot <file>    # ingest a saved snapshot instead of collecting
//
// Exit codes: 0 success, 1 failed (nothing written), 2 partial (written, crawl
// stopped on its budget). Snapshots of real runs are archived to Spaces.
//
// Dependencies are injected so the tests run without a database; the CLI
// wiring sits at the bottom and only runs when this file is the entry point.

const LOOKUP_BATCH_SIZE = 1000;
const UPSERT_BATCH_SIZE = 2000;
const LOG_EVERY = 500;
const TDOT_COMPETITOR_ID = 4;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseArgs(argv) {
  const args = { dryRun: false, fromSnapshot: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--from-snapshot") args.fromSnapshot = argv[++i] || null;
    else if (argv[i].startsWith("--from-snapshot=")) args.fromSnapshot = argv[i].slice("--from-snapshot=".length) || null;
  }
  return args;
}

const DEFAULT_MATCH_DROP_RATIO = 0.8;
const EXIT_PARTIAL = 2;

function errorDetail(error) {
  const message = String(error && error.message ? error.message : error);
  if (!error || !error.code || message.startsWith(error.code)) return message;
  return `${error.code}: ${message}`;
}

// Two of our products can share one tdot_code (six labels are used by two jj
// prefixes). The old seed let the last row win, so the owner changed between
// runs. Here the active product wins, then the lower sku, every time.
function indexProductsByTdotCode(products) {
  const sorted = [...products].sort((a, b) => {
    const activeA = Number(a.status) === 1 ? 0 : 1;
    const activeB = Number(b.status) === 1 ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;
    return String(a.sku).localeCompare(String(b.sku));
  });
  const byCode = new Map();
  for (const product of sorted) {
    if (!byCode.has(product.tdot_code)) byCode.set(product.tdot_code, product.sku);
  }
  return byCode;
}

async function lastWrittenRowCount(prisma) {
  if (!prisma.ingestRun || typeof prisma.ingestRun.findFirst !== "function") return null;
  const last = await prisma.ingestRun.findFirst({
    where: { feed: "tdot", status: { in: ["success", "partial"] }, startedBy: { not: "dry-run" } },
    orderBy: { startedAt: "desc" },
    select: { id: true, sourceRowCount: true },
  });
  return last && Number.isFinite(last.sourceRowCount) && last.sourceRowCount > 0 ? last : null;
}

// Seed Tdot competitor products. Returns { exitCode, counts, wouldWrite, summary }.
// exitCode: 0 success, 1 failed (nothing written), 2 partial (written, but the
// crawl stopped early; the cron e-mail must fire).
async function runSeedTdot({
  prisma, source, startRun, argv = [], logger = console, now = () => new Date(), env = process.env,
  archive = null, matchDropRatio = Number(env.TDOT_MATCH_DROP_RATIO) || DEFAULT_MATCH_DROP_RATIO,
}) {
  const args = parseArgs(argv);
  const startedAt = now();
  const logWithTimestamp = (message) => logger.info(`[${now().toISOString()}] ${message}`);
  const sourceRef = args.fromSnapshot || (typeof source.describe === "function" ? source.describe() : "klevu:tdotperformance.ca");
  const run = await startRun("tdot", {
    sourceKind: args.fromSnapshot ? "snapshot" : "api",
    sourceRef,
    startedBy: args.dryRun ? "dry-run" : env.INGEST_TRIGGER || "cron",
  });
  logWithTimestamp(`[tdot] run ${run.id} started${args.dryRun ? " (dry-run)" : ""} source=${sourceRef}`);

  const finishRun = async (outcome) => {
    try {
      await run.finish(outcome);
    } catch (err) {
      logger.error(`[tdot] run ${run.id}: could not record the run outcome (${outcome.status}): ${err.message}`);
    }
  };

  try {
    const { rows: competitorProductsData, payload, snapshotPath } = await source.fetchRows({ dryRun: args.dryRun, runId: run.id, fromSnapshot: args.fromSnapshot });
    const totalRows = competitorProductsData.length;
    logWithTimestamp(`Total competitor products to process: ${totalRows}`);

    const validRows = competitorProductsData
      .map((data) => {
        const tdotCode = data.tdot_code?.trim();
        const price = Number(data.tdot_price);
        if (!tdotCode || Number.isNaN(price)) {
          return null;
        }
        return {
          tdotCode,
          price,
          productUrl: data.product_url || null,
        };
      })
      .filter(Boolean);

    const validRowCount = validRows.length;
    logWithTimestamp(`Valid rows (non-empty code + price): ${validRowCount}`);

    const rowByTdotCode = new Map();
    let processed = 0;

    for (const row of validRows) {
      rowByTdotCode.set(row.tdotCode, row);
      processed++;
      if (processed % LOG_EVERY === 0) {
        logWithTimestamp(`Processed ${processed} rows...`);
      }
    }

    const uniqueCodes = Array.from(rowByTdotCode.keys());
    logWithTimestamp(`Unique tdot codes after dedupe: ${uniqueCodes.length}`);
    logWithTimestamp(`Loading products for ${uniqueCodes.length} tdot codes...`);

    const productByTdot = new Map();
    for (const codeChunk of chunkArray(uniqueCodes, LOOKUP_BATCH_SIZE)) {
      const products = await prisma.product.findMany({
        where: { tdot_code: { in: codeChunk } },
        select: { sku: true, tdot_code: true, status: true },
      });
      for (const [code, sku] of indexProductsByTdotCode(products)) {
        if (!productByTdot.has(code)) productByTdot.set(code, sku);
      }
    }

    logWithTimestamp(
      `Loading existing competitor products for ${uniqueCodes.length} tdot codes...`
    );

    const existingBySku = new Map();
    for (const codeChunk of chunkArray(uniqueCodes, LOOKUP_BATCH_SIZE)) {
      const existing = await prisma.competitorProduct.findMany({
        where: {
          competitor_id: TDOT_COMPETITOR_ID,
          competitor_sku: { in: codeChunk },
        },
        select: { competitor_sku: true },
      });

      for (const record of existing) {
        existingBySku.set(record.competitor_sku, true);
      }
    }

    const upsertRows = [];
    let createsCount = 0;
    let updatesCount = 0;
    let missingProductCount = 0;

    for (const [tdotCode, row] of rowByTdotCode.entries()) {
      const productSku = productByTdot.get(tdotCode);
      if (!productSku) {
        missingProductCount++;
        continue;
      }

      if (existingBySku.has(tdotCode)) {
        updatesCount++;
      } else {
        createsCount++;
      }

      upsertRows.push({
        product_sku: productSku,
        competitor_sku: tdotCode,
        competitor_price: row.price * 1,
        product_url: row.productUrl,
      });
    }

    logWithTimestamp(`Missing products for tdot codes: ${missingProductCount}`);
    logWithTimestamp(`Existing competitor products found: ${existingBySku.size}`);
    logWithTimestamp(`Creates queued: ${createsCount}`);
    logWithTimestamp(`Updates queued: ${updatesCount}`);

    // Guards that do not depend on the source: a snapshot or ParseHub run has
    // no collector canaries, so the row count is checked here as well.
    if (upsertRows.length === 0) {
      throw Object.assign(new Error(`no matched rows to write (source rows ${totalRows}, valid ${validRowCount})`), { code: "TDOT_NO_ROWS" });
    }
    const last = await lastWrittenRowCount(prisma);
    if (last && upsertRows.length < matchDropRatio * last.sourceRowCount) {
      throw Object.assign(
        new Error(`matched ${upsertRows.length} rows, below ${matchDropRatio} of the ${last.sourceRowCount} written by run ${last.id}; refusing to write`),
        { code: "TDOT_MATCH_DROP" }
      );
    }

    const upsertBatch = async (batch) => {
      if (!batch || batch.length === 0) return;
      const payload = JSON.stringify(batch);

      const updateSql = `
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            product_sku text,
            competitor_sku text,
            competitor_price double precision,
            product_url text
          )
        )
        UPDATE "CompetitorProduct" cp
        SET
          product_sku = input.product_sku,
          competitor_price = input.competitor_price,
          product_url = input.product_url,
          updated_at = CURRENT_TIMESTAMP
        FROM input
        WHERE cp.competitor_id = $1
          AND cp.competitor_sku = input.competitor_sku
          AND (
            cp.product_sku IS DISTINCT FROM input.product_sku
            OR cp.competitor_price IS DISTINCT FROM input.competitor_price
            OR cp.product_url IS DISTINCT FROM input.product_url
          );
      `;

      const insertSql = `
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            product_sku text,
            competitor_sku text,
            competitor_price double precision,
            product_url text
          )
        )
        INSERT INTO "CompetitorProduct" (
          product_sku,
          competitor_id,
          competitor_price,
          competitor_sku,
          product_url
        )
        SELECT
          input.product_sku,
          $1,
          input.competitor_price,
          input.competitor_sku,
          input.product_url
        FROM input
        WHERE NOT EXISTS (
          SELECT 1
          FROM "CompetitorProduct" cp
          WHERE cp.competitor_id = $1
            AND cp.competitor_sku = input.competitor_sku
        );
      `;

      return prisma.$transaction([
        prisma.$executeRawUnsafe(updateSql, TDOT_COMPETITOR_ID, payload),
        prisma.$executeRawUnsafe(insertSql, TDOT_COMPETITOR_ID, payload),
      ]);
    };

    const counts = { inserted: 0, updated: 0, skipped: 0 };
    if (args.dryRun) {
      logWithTimestamp(`[tdot] dry-run: ${upsertRows.length} rows would be written (creates ${createsCount}, updates ${updatesCount}), nothing written`);
    } else {
      let processedUpserts = 0;
      for (const upsertChunk of chunkArray(upsertRows, UPSERT_BATCH_SIZE)) {
        const [updated, inserted] = await upsertBatch(upsertChunk);
        counts.updated += Number(updated) || 0;
        counts.inserted += Number(inserted) || 0;
        processedUpserts += upsertChunk.length;
        logWithTimestamp(
          `Upserted ${processedUpserts}/${upsertRows.length} competitor records...`
        );
      }
      counts.skipped = upsertRows.length - counts.inserted - counts.updated;
      logWithTimestamp(
        `Competitor products from Tdot seeded successfully! Inserted: ${counts.inserted}, Updated (price or link changed): ${counts.updated}, Unchanged: ${counts.skipped}`
      );
    }

    const collection = payload && payload.collection ? payload.collection : null;
    const partial = Boolean(collection && collection.partial);
    const status = args.dryRun ? "dry-run" : partial ? "partial" : "success";
    const summary = {
      runId: run.id, status, sourceRows: totalRows, validRows: validRowCount, uniqueCodes: uniqueCodes.length,
      missingProducts: missingProductCount, wouldWrite: upsertRows.length, ...counts,
      ...(collection ? { requests: collection.requests, failedRequests: collection.failedRequests, matched: collection.matched, unmatched: collection.unmatched, invalid: collection.invalidCount, partial } : {}),
    };
    logWithTimestamp(`[tdot] SUMMARY ${JSON.stringify(summary)}`);
    if (partial) logger.warn(`[tdot] run ${run.id} is PARTIAL: the crawl stopped on its budget (${collection.labelsOverBudget} labels not fetched); rows written, exit code ${EXIT_PARTIAL}`);
    await finishRun({
      status, counts, sourceRowCount: upsertRows.length,
      ...(partial ? { error: `TDOT_PARTIAL: ${collection.labelsOverBudget} labels over budget` } : {}),
    });
    if (!args.dryRun && snapshotPath && archive) {
      try {
        const result = await archive({ filePath: snapshotPath, command: "seed-tdot", startedAt, status, source: env.INGEST_TRIGGER || "cron", extension: "json" });
        logWithTimestamp(`[tdot] snapshot archive: ${result.archived ? result.key : `skipped (${result.reason})`}`);
      } catch (err) {
        logger.warn(`[tdot] snapshot archive failed: ${err.message}`);
      }
    }
    return { exitCode: partial && !args.dryRun ? EXIT_PARTIAL : 0, counts, wouldWrite: upsertRows.length, summary };
  } catch (error) {
    const detail = errorDetail(error);
    logger.error(`[tdot] run ${run.id} FAILED: ${detail}`);
    await finishRun({ status: "failed", error: detail });
    return { exitCode: 1, counts: null, wouldWrite: 0, error: detail };
  }
}

async function main() {
  const prisma = require("../../../lib/prisma");
  const { startRun } = require("../../../lib/ingest/ingestRun");
  const { createTdotSource } = require("../api-calls/tdot-api.js");
  const { createLogArchive } = require("../../../services/logArchive/logArchiveService");
  try {
    const result = await runSeedTdot({
      prisma, source: createTdotSource({ prisma }), startRun, argv: process.argv.slice(2),
      archive: (args) => createLogArchive().archiveFile(args),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error("Error seeding competitor products from Tdot:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main();
module.exports = { runSeedTdot, parseArgs, indexProductsByTdotCode, EXIT_PARTIAL };
