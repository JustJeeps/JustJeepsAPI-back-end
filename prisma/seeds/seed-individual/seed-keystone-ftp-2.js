/* prisma/seeds/seed-individual/seed-keystone-ftp-2.js */

const fs = require("fs");
const path = require("path");
const prisma = require("../../../lib/prisma");
const { hashFiles } = require("../../../lib/ingest/fileHash");
const { startRun, isUnchanged } = require("../../../lib/ingest/ingestRun");
const { ensureStagingTable, insertBatch, queryStaging, closePool } = require("../../../lib/ingest/stageTable");
const { diffApply } = require("../../../lib/ingest/diffApply");
const { streamCsvBatched } = require("../../../lib/ingest/streamCsv");
const { withRetry } = require("../../../lib/ingest/withRetry");

// ---- CONFIG ----
const VENDOR_ID = 1; // Keystone
const FEED = "keystone-ftp";
const BASE_DIR = path.join(__dirname, "../api-calls/keystone_files");
const INVENTORY_FILE = path.join(BASE_DIR, "Inventory.csv");
const SPECIAL_ORDER_FILE = path.join(BASE_DIR, "SpecialOrder.csv");
const STAGE_BATCH = 5000;
const MIN_RATIO = Number(process.env.KEYSTONE_FTP2_MIN_RATIO || 0.5);

// ---- helpers (preservados do legado) ----
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/\$/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanCsvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).trim();
  if (!s) return "";
  if (/^=\s*".*"$/.test(s)) s = s.replace(/^=\s*"(.*)"$/, "$1");
  return s.replace(/^"+|"+$/g, "").trim();
}

function getField(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
  }
  return undefined;
}

// Revolution Gear: Keystone usa RGAEV..., alguns produtos foram gerados RGAREV...
function getEquivalentKeystoneCodes(code) {
  const out = [code];
  if (/^RGAEV/i.test(code)) {
    out.push(`RGAR${code.slice(3)}`);
  } else if (/^RGAREV/i.test(code)) {
    out.push(`RGA${code.slice(4)}`);
  }
  return out;
}

// Em colisao de keystone_code, prefere SKU que NAO termina com "-"
function preferSku(currentSku, candidateSku) {
  if (!currentSku) return candidateSku;
  const curEndsWithDash = currentSku.endsWith("-");
  const candEndsWithDash = candidateSku.endsWith("-");
  if (curEndsWithDash && !candEndsWithDash) return candidateSku;
  return currentSku;
}

async function loadProductsByKeystoneCodes() {
  console.log("🔎 Loading all Products by non-null keystone_code...");
  const codeToSku = new Map();
  let collisionsResolved = 0;

  const products = await withRetry(
    () =>
      prisma.product.findMany({
        where: { keystone_code: { not: null } },
        select: { sku: true, keystone_code: true },
      }),
    "product.findMany(all keystone_code)"
  );

  for (const p of products) {
    const code = p.keystone_code;
    if (!code) continue;
    const current = codeToSku.get(code);
    const chosen = preferSku(current, p.sku);
    if (current && chosen !== current) collisionsResolved++;
    codeToSku.set(code, chosen);
  }

  console.log(`ℹ️ Loaded ${codeToSku.size.toLocaleString()} unique keystone_code mappings (${collisionsResolved} collisions resolved).`);
  return codeToSku;
}

// Casa uma linha do feed com um Product: equivalentes do VCPN e, se falhar,
// equivalentes do fallback VendorCode+ManufacturerPartNo. Mesmo criterio do
// legado — mas executado NO STREAM, entao linhas sem match sao descartadas
// imediatamente (memoria O(batch), nao O(2,5M)).
function matchSku(codeToSku, vcpn, vendorCode, manufacturerPartNo) {
  for (const candidate of getEquivalentKeystoneCodes(vcpn)) {
    const sku = codeToSku.get(candidate);
    if (sku) return sku;
  }
  if (vendorCode && manufacturerPartNo) {
    const fallback = `${vendorCode}${manufacturerPartNo}`;
    if (fallback && fallback !== vcpn) {
      for (const candidate of getEquivalentKeystoneCodes(fallback)) {
        const sku = codeToSku.get(candidate);
        if (sku) return sku;
      }
    }
  }
  return null;
}

const STAGING_RAW = "vp_keystone_raw";
const STAGING_RAW_DDL = `
  vcpn TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  vendor_id INTEGER NOT NULL,
  vendor_sku TEXT NOT NULL,
  vendor_cost DOUBLE PRECISION NOT NULL,
  vendor_inventory DOUBLE PRECISION,
  source_rank INTEGER NOT NULL,
  has_qty INTEGER NOT NULL,
  qty_val DOUBLE PRECISION NOT NULL
`;
const STAGING_RAW_COLS = [
  "vcpn", "product_sku", "vendor_id", "vendor_sku", "vendor_cost",
  "vendor_inventory", "source_rank", "has_qty", "qty_val",
];

async function stageFile(filePath, sourceRank, codeToSku, summary) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const fileName = path.basename(filePath);

  const transform = (r) => {
    const vcpn = cleanCsvField(getField(r, "VCPN"));
    if (!vcpn) return null;

    const cost = toNumber(getField(r, "DealerPrice", "Dealer Price", "Cost", "Price"));
    // Sem custo numerico a linha nunca venceria o score nem poderia ser
    // inserida (vendor_cost e NOT NULL) — mesmo resultado do skippedNoCost legado.
    if (!isNum(cost)) return null;

    const vendorCode = cleanCsvField(getField(r, "VendorCode", "Vendor Code"));
    const manufacturerPartNo = cleanCsvField(
      getField(r, "ManufacturerPartNo", "Manufacturer Part No", "MfgPartNo")
    );
    const sku = matchSku(codeToSku, vcpn, vendorCode, manufacturerPartNo);
    if (!sku) return null;

    const vendorPart = cleanCsvField(getField(r, "VendorPart", "Vendor Part"));
    const qty = toNumber(getField(r, "TotalQty", "Total Qty", "Qty", "QTY", "Inventory"));

    summary.matched++;
    return {
      vcpn,
      product_sku: sku,
      vendor_id: VENDOR_ID,
      vendor_sku: vendorPart || vcpn,
      vendor_cost: cost,
      vendor_inventory: isNum(qty) ? qty : null,
      source_rank: sourceRank,
      has_qty: isNum(qty) ? 1 : 0,
      qty_val: isNum(qty) ? qty : -1,
    };
  };

  const res = await streamCsvBatched(filePath, { batchSize: STAGE_BATCH, transform }, (batch) =>
    insertBatch(STAGING_RAW, STAGING_RAW_COLS, batch)
  );
  console.log(`📄 ${fileName}: ${res.rowsRead.toLocaleString()} linhas lidas, ${res.rowsKept.toLocaleString()} com match+custo staged`);
  summary.rowsRead += res.rowsRead;
  return res;
}

// Pipeline novo: o dedup/score que era um invMap de ~2,4M entradas em heap
// (OOM a 1024MB) agora e um DISTINCT ON no staging — memoria do processo fica
// O(batch) + mapa de produtos (~dezenas de milhares).
async function seedKeystoneStaged() {
  const t0 = Date.now();
  let run;

  try {
    console.log("🚀 Seeding Keystone vendor products from local CSVs (staged pipeline)...");

    const sourceHash = await hashFiles([INVENTORY_FILE, SPECIAL_ORDER_FILE]);
    run = await startRun(FEED, {
      sourceKind: "ftp-csv",
      sourceRef: "Inventory.csv+SpecialOrder.csv",
      sourceHash,
    });

    if (await isUnchanged(FEED, sourceHash)) {
      console.log("⏭️  Fonte identica a ultima rodada bem-sucedida — nada a fazer.");
      await run.finish({ status: "skipped-unchanged", counts: { skipped: 1 } });
      return;
    }

    const codeToSku = await loadProductsByKeystoneCodes();

    await ensureStagingTable(STAGING_RAW, STAGING_RAW_DDL);
    const summary = { rowsRead: 0, matched: 0 };
    // Inventory primeiro (source_rank 2 > SpecialOrder 1, mesmo criterio do score legado)
    await stageFile(INVENTORY_FILE, 2, codeToSku, summary);
    await stageFile(SPECIAL_ORDER_FILE, 1, codeToSku, summary);

    // Dedup em SQL, replicando o score legado [hasCost, source, hasQty, qty]:
    // 1) melhor linha por VCPN; 2) uma linha por vendor_sku (constraint nova).
    await queryStaging(`
      CREATE UNLOGGED TABLE IF NOT EXISTS staging.vp_keystone_final (LIKE staging.${STAGING_RAW});
      TRUNCATE staging.vp_keystone_final;
    `);
    await queryStaging(`
      INSERT INTO staging.vp_keystone_final
      SELECT DISTINCT ON (vendor_sku) *
      FROM (
        SELECT DISTINCT ON (vcpn) *
        FROM staging.${STAGING_RAW}
        ORDER BY vcpn, source_rank DESC, has_qty DESC, qty_val DESC
      ) best_per_vcpn
      ORDER BY vendor_sku, source_rank DESC, has_qty DESC, qty_val DESC, vcpn
    `);
    const staged = await queryStaging(`SELECT count(*)::int AS n FROM staging.vp_keystone_final`);
    const stagedCount = staged.rows[0].n;
    console.log(`✅ Staged ${stagedCount.toLocaleString()} linhas unicas (de ${summary.matched.toLocaleString()} matches em ${summary.rowsRead.toLocaleString()} lidas)`);

    const currentCount = await prisma.vendorProduct.count({ where: { vendor_id: VENDOR_ID } });
    if (currentCount > 0 && stagedCount < currentCount * MIN_RATIO) {
      throw new Error(
        `Feed encolheu demais: ${stagedCount} staged vs ${currentCount} no banco ` +
        `(minimo ${Math.ceil(currentCount * MIN_RATIO)}). FTP truncado? Abortado sem tocar o banco.`
      );
    }

    console.time("diff+apply");
    const counts = await diffApply({
      target: "VendorProduct",
      staging: "staging.vp_keystone_final",
      keyCols: ["vendor_id", "vendor_sku"],
      compareCols: ["product_sku", "vendor_cost", "vendor_inventory"],
      insertCols: ["product_sku", "vendor_id", "vendor_sku", "vendor_cost", "vendor_inventory"],
      scopeWhereSql: `t."vendor_id" = ${VENDOR_ID}`,
      staleStrategy: "delete",
    });
    console.timeEnd("diff+apply");

    console.log(`✅ Diff aplicado: +${counts.inserted} inseridas, ~${counts.updated} atualizadas, -${counts.stale} removidas`);
    console.log(`✅ Intocadas: ${stagedCount - counts.inserted - counts.updated} (sem mudanca)`);

    await run.finish({
      status: "success",
      counts: { inserted: counts.inserted, updated: counts.updated, deleted: counts.stale },
      sourceRowCount: summary.rowsRead,
    });

    const count = await prisma.vendorProduct.count({ where: { vendor_id: VENDOR_ID } });
    console.log(`✅ VendorProduct count for Keystone (vendor_id=${VENDOR_ID}): ${count}`);
    console.log(`seed-keystone-ftp2 total: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  } catch (e) {
    console.error("❌ Seed failed:", e);
    if (run) {
      await run.finish({ status: "failed", error: e.message }).catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    await closePool();
    await prisma.$disconnect();
  }
}

seedKeystoneStaged();
module.exports = seedKeystoneStaged;
