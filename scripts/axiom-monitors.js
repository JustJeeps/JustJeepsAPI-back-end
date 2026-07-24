#!/usr/bin/env node

// Cria/atualiza (idempotente) os monitores do Axiom versionados neste repo.
// Monitor-as-code: rodar de novo casa o monitor por NOME e faz PUT no existente,
// nunca duplica. E' uma ferramenta de setup rodada LOCALMENTE — nao roda em
// producao nem no boot do app.
//
// Requer AXIOM_MGMT_TOKEN: um Personal Access Token (PAT) ou API token com
// escopo de gerenciamento de monitores. O AXIOM_TOKEN de ingestao NAO serve
// (so escreve eventos). Se usar um PAT (que varre varias orgs), defina tambem
// AXIOM_ORG_ID com o id da org. ⚠️ Guarde o token em .env local (gitignored);
// nunca commite — ja houve vazamento de chaves no .kamal/secrets.
//
// Uso:  node scripts/axiom-monitors.js            (cria/atualiza)
//       node scripts/axiom-monitors.js --dry-run  (so mostra o que faria)

const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const API_BASE = process.env.AXIOM_API_URL || "https://api.axiom.co";
const TOKEN = process.env.AXIOM_MGMT_TOKEN;
const ORG_ID = process.env.AXIOM_ORG_ID; // opcional; necessario para PAT
const DATASET = process.env.AXIOM_DATASET || "justjeeps-api";
const INGEST_NOTIFIER = process.env.AXIOM_INGEST_NOTIFIER || "BAbASf5WlFkdMpNx33";
const DRY_RUN = process.argv.includes("--dry-run");

// Feeds que MUDAM com frequencia — skip prolongado neles sugere download
// silenciosamente velho (hash batendo num arquivo estagnado). Quadratec fica de
// fora: le um arquivo commitado, entao skip longo e' esperado, nao staleness.
// meyer-ca/meyer-us so emitem eventos ingest_run apos a migracao stage+diff.
const WATCHED_FEEDS = ["keystone-ftp", "meyer-ca", "meyer-us"];

const monitors = [
  {
    name: "Ingest Feed Stale — só skips sem sucesso (P2)",
    type: "Threshold",
    description:
      "Alerta quando um feed de ingestao que deveria mudar (keystone/meyer) so " +
      "produz skipped-unchanged (0 success) por ~26h — possivel download " +
      "silenciosamente velho. Quadratec fica de fora (arquivo commitado).",
    aplQuery: [
      `['${DATASET}']`,
      `| where type == "ingest_run" and feed in (${WATCHED_FEEDS.map((f) => `"${f}"`).join(", ")})`,
      `| summarize successes = countif(outcome == "success"), skips = countif(outcome == "skipped-unchanged") by feed`,
      `| where successes == 0 and skips > 0`,
      `| project feed, value = skips`,
    ].join("\n"),
    columnName: "value", // coluna agregada onde o threshold e' aplicado
    operator: "AboveOrEqual",
    threshold: 2, // >=2 rodadas na janela, todas skip, zero sucesso
    rangeMinutes: 1560, // ~26h: cobre com folga as 2 rodadas diarias (06:00 e 19:00)
    intervalMinutes: 60,
    alertOnNoData: false, // nao alertar feed que simplesmente nao rodou
    notifyByGroup: true, // um alerta por feed (grupo do `by feed`)
    resolvable: true,
    notifierIds: [INGEST_NOTIFIER],
  },
];

function makeClient() {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (ORG_ID) headers["X-Axiom-Org-Id"] = ORG_ID;
  return axios.create({ baseURL: API_BASE, headers, timeout: 30000 });
}

async function listMonitors(api) {
  const { data } = await api.get("/v2/monitors");
  if (Array.isArray(data)) return data;
  return data.monitors || data.data || [];
}

async function upsertMonitor(api, def) {
  const existing = (await listMonitors(api)).find((m) => m.name === def.name);

  if (existing) {
    await api.put(`/v2/monitors/${existing.id}`, { ...def });
    console.log(`✔ atualizado: ${def.name} (id ${existing.id})`);
    return;
  }
  const { data } = await api.post("/v2/monitors", def);
  console.log(`✔ criado: ${def.name} (id ${data && data.id})`);
}

async function main() {
  if (DRY_RUN) {
    for (const def of monitors) {
      console.log(`[dry-run] payload para: ${def.name}`);
      console.log(JSON.stringify(def, null, 2));
    }
    return;
  }

  if (!TOKEN) {
    console.error(
      "ERRO: AXIOM_MGMT_TOKEN nao definido. Precisa de um PAT ou API token com " +
        "escopo de monitores (o AXIOM_TOKEN de ingestao NAO serve)."
    );
    process.exit(1);
  }

  const api = makeClient();
  for (const def of monitors) {
    try {
      await upsertMonitor(api, def);
    } catch (e) {
      const detail = e.response
        ? `${e.response.status} ${JSON.stringify(e.response.data)}`
        : e.message;
      console.error(`✗ falhou: ${def.name} — ${detail}`);
      process.exitCode = 1;
    }
  }
}

main();
