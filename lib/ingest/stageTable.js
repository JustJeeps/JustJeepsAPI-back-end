const { Pool } = require("pg");

// Tabelas de staging UNLOGGED permanentes (schema `staging`): truncate+reload
// a cada rodada. UNLOGGED = sem WAL (rapido; conteudo se perde em crash, o que
// e irrelevante — regenerado toda rodada). Permanentes (nao TEMP) para nao
// prender uma conexao/transacao longa e para permitir inspecao pos-rodada.
//
// Usa `pg` direto (nao Prisma) para inserts multi-row eficientes com uma
// conexao curta dedicada.

let pool = null;

function buildSslConfig(connectionString) {
  const mode = (/sslmode=(require|verify-ca|verify-full)/.exec(connectionString) || [])[1];
  if (!mode) return undefined;

  // Verificacao completa quando o CA do cluster estiver disponivel (baixavel
  // no painel da DO): aponte DATABASE_CA_CERT para o .crt.
  const caPath = process.env.DATABASE_CA_CERT;
  if (caPath) {
    const fs = require("fs");
    return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  }

  // verify-ca/verify-full declarados na URL EXIGEM cadeia validada — sem CA
  // configurado e erro de setup, nunca downgrade silencioso.
  if (mode === "verify-ca" || mode === "verify-full") {
    throw new Error(`sslmode=${mode} requer DATABASE_CA_CERT apontando para o CA do cluster`);
  }

  // sslmode=require (semantica libpq): conexao CRIPTOGRAFADA sem validacao de
  // cadeia — identico ao que o Prisma faz com esta mesma URL. Aceitavel apenas
  // porque o tráfego e app->PG gerenciado em rede confiavel; para verificacao
  // completa, configure DATABASE_CA_CERT.
  return { rejectUnauthorized: false };
}

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL environment variable is not set");

  pool = new Pool({
    connectionString,
    max: 2,
    ssl: buildSslConfig(connectionString),
  });
  return pool;
}

// Limite de bind params do protocolo (int16). Mantem folga.
const MAX_PARAMS = 60000;

async function ensureStagingTable(tableName, columnsSql) {
  const pg = getPool();
  await pg.query("CREATE SCHEMA IF NOT EXISTS staging");
  await pg.query(`CREATE UNLOGGED TABLE IF NOT EXISTS staging.${tableName} (${columnsSql})`);
  await pg.query(`TRUNCATE staging.${tableName}`);
}

// rows: array de objetos; cols: nomes das colunas (ordem estavel).
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
