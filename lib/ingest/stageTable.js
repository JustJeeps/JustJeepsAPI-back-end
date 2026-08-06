const { Pool } = require("pg");

// Permanent UNLOGGED staging tables (schema `staging`): truncate and reload on
// every run. UNLOGGED means no WAL (fast; the content is lost on a crash, which
// is irrelevant here since it is regenerated every run). They are permanent (not
// TEMP) so we do not hold a long lived connection or transaction, and so the
// data can be inspected after the run.
//
// Uses `pg` directly (not Prisma) for efficient multi-row inserts over a short
// dedicated connection.

let pool = null;

function buildSslConfig(connectionString) {
  const mode = (/sslmode=(require|verify-ca|verify-full)/.exec(connectionString) || [])[1];
  if (!mode) return undefined;

  // Full verification when the cluster CA is available (downloadable from the
  // DO panel): point DATABASE_CA_CERT at the .crt file.
  const caPath = process.env.DATABASE_CA_CERT;
  if (caPath) {
    const fs = require("fs");
    return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  }

  // verify-ca/verify-full declared in the URL REQUIRE a validated chain: with no
  // CA configured this is a setup error, never a silent downgrade.
  if (mode === "verify-ca" || mode === "verify-full") {
    throw new Error(`sslmode=${mode} requires DATABASE_CA_CERT pointing at the cluster CA`);
  }

  // sslmode=require (libpq semantics): ENCRYPTED connection without chain
  // validation, identical to what Prisma does with this same URL. Acceptable
  // only because the traffic is app to managed PG over a trusted network; for
  // full verification, configure DATABASE_CA_CERT.
  return { rejectUnauthorized: false };
}

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL environment variable is not set");

  // pg also parses sslmode from the URL and OVERRIDES the explicit `ssl` object
  // (turning on chain verification that the DO CA does not pass). We strip
  // sslmode from the URL and pass only the ssl config built above.
  const ssl = buildSslConfig(connectionString);
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");

  pool = new Pool({
    connectionString: url.toString(),
    max: 2,
    ssl,
  });
  return pool;
}

// Protocol bind parameter limit (int16). Keeps some headroom.
const MAX_PARAMS = 60000;

async function ensureStagingTable(tableName, columnsSql) {
  const pg = getPool();
  await pg.query("CREATE SCHEMA IF NOT EXISTS staging");
  await pg.query(`CREATE UNLOGGED TABLE IF NOT EXISTS staging.${tableName} (${columnsSql})`);
  await pg.query(`TRUNCATE staging.${tableName}`);
}

// rows: array of objects; cols: column names (stable order).
async function insertBatch(tableName, cols, rows) {
  if (!rows.length) return 0;
  const pg = getPool();

  const maxRowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += maxRowsPerStmt) {
    const slice = rows.slice(offset, offset + maxRowsPerStmt);
    const values = [];
    const placeholders = slice.map((row, r) => {
      const ph = cols.map((col, c) => {
        values.push(row[col] === undefined ? null : row[col]);
        return `$${r * cols.length + c + 1}`;
      });
      return `(${ph.join(",")})`;
    });

    const sql = `INSERT INTO staging.${tableName} (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${placeholders.join(",")}`;
    const res = await pg.query(sql, values);
    inserted += res.rowCount || 0;
  }

  return inserted;
}

async function queryStaging(sql, params = []) {
  const pg = getPool();
  const res = await pg.query(sql, params);
  return res;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { ensureStagingTable, insertBatch, queryStaging, closePool };
