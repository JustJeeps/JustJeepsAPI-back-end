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

// Feeds cuja FONTE se renova sozinha — skip prolongado neles sugere download
// silenciosamente velho. Quadratec E keystone-ftp ficam de FORA: ambos leem
// arquivos COMMITADOS na imagem (o download FTP do keystone esta desativado no
// seed-all — descoberta de 24/jul), entao skip continuo e' o estado esperado,
// nao staleness. Reincluir keystone-ftp SE o download em runtime voltar.
// meyer-ca/meyer-us so emitem ingest_run apos a migracao stage+diff (ate la o
// monitor fica silencioso: alertOnNoData=false).
const WATCHED_FEEDS = ["meyer-ca", "meyer-us"];

// Destinatarios do notifier de e-mail (INGEST_NOTIFIER). tsantos foi removida
// sem querer na migracao de mai/2026 que apontou tudo para developer@.
const NOTIFIER_EMAILS = ["developer@justjeeps.com", "tsantos@justjeeps.com"];

const monitors = [
  {
    // Casa por NOME com o monitor existente (id 5joi92SRRX9oSrDBEg) → PUT, nao
    // duplica. Redefinido em jul/2026: a versao antiga ("zero eventos em 3min")
    // disparava toda madrugada — /api/health e' excluido do logger e o trafego
    // noturno cai a ~12 req/h, entao janelas vazias eram garantidas. Agora o
    // sinal e' a ausencia do heartbeat de 60s que o server.js emite
    // (logger.heartbeat), imune ao volume de trafego.
    name: "API Offline (P1)",
    type: "Threshold",
    description:
      "Zero heartbeats em 5min — queda real do processo ou do pipeline de log " +
      "(o app emite heartbeat 1x/min; trafego de madrugada nao influencia).",
    aplQuery: [
      `['${DATASET}']`,
      `| where type == "heartbeat"`,
      `| summarize value = count()`,
    ].join("\n"),
    columnName: "value",
    operator: "Below",
    threshold: 1,
    rangeMinutes: 5,
    intervalMinutes: 1,
    alertOnNoData: true, // sem linhas = sem heartbeat = alerta
    resolvable: true,
    notifierIds: [INGEST_NOTIFIER],
  },
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

// Declarativo (decisao do usuario, 24/jul): o notifier deve ter EXATAMENTE os
// NOTIFIER_EMAILS — adiciona quem falta e REMOVE quem nao esta na lista.
// GET → compara → PUT so se mudou, logando o delta.
async function ensureNotifierEmails(api, notifierId, emails) {
  const { data: notifier } = await api.get(`/v2/notifiers/${notifierId}`);
  const current = (notifier.properties && notifier.properties.email && notifier.properties.email.emails) || [];
  const desired = Array.from(new Set(emails));
  const same = current.length === desired.length && desired.every((e) => current.includes(e));
  if (same) {
    console.log(`✔ notifier ${notifierId} ja e' exatamente: ${desired.join(", ")}`);
    return;
  }
  const added = desired.filter((e) => !current.includes(e));
  const removed = current.filter((e) => !desired.includes(e));
  await api.put(`/v2/notifiers/${notifierId}`, {
    ...notifier,
    properties: { ...notifier.properties, email: { ...notifier.properties.email, emails: desired } },
  });
  console.log(
    `✔ notifier ${notifierId} → ${desired.join(", ")}` +
    (added.length ? ` | adicionados: ${added.join(", ")}` : "") +
    (removed.length ? ` | removidos: ${removed.join(", ")}` : "")
  );
}

async function main() {
  if (DRY_RUN) {
    console.log(`[dry-run] notifier ${INGEST_NOTIFIER} → garantir e-mails: ${NOTIFIER_EMAILS.join(", ")}`);
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

  try {
    await ensureNotifierEmails(api, INGEST_NOTIFIER, NOTIFIER_EMAILS);
  } catch (e) {
    const detail = e.response
      ? `${e.response.status} ${JSON.stringify(e.response.data)}`
      : e.message;
    console.error(`✗ notifier ${INGEST_NOTIFIER} — ${detail}`);
    process.exitCode = 1;
  }

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
