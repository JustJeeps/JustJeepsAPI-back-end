#!/usr/bin/env node

// Creates/updates (idempotently) the Axiom monitors versioned in this repo.
// Monitor-as-code: running it again matches the monitor by NAME and PUTs over
// the existing one, it never duplicates. This is a setup tool run LOCALLY: it
// does not run in production nor at app boot.
//
// Requires AXIOM_MGMT_TOKEN: a Personal Access Token (PAT) or API token with
// monitor management scope. The AXIOM_TOKEN used for ingestion does NOT work
// (it only writes events). If you use a PAT (which spans several orgs), also
// set AXIOM_ORG_ID with the org id. ⚠️ Keep the token in a local .env
// (gitignored) and never commit it: keys have already leaked in .kamal/secrets.
//
// Usage:  node scripts/axiom-monitors.js            (create/update)
//         node scripts/axiom-monitors.js --dry-run  (only prints what it would do)

const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const API_BASE = process.env.AXIOM_API_URL || "https://api.axiom.co";
const TOKEN = process.env.AXIOM_MGMT_TOKEN;
const ORG_ID = process.env.AXIOM_ORG_ID; // optional; required for a PAT
const DATASET = process.env.AXIOM_DATASET || "justjeeps-api";
const INGEST_NOTIFIER = process.env.AXIOM_INGEST_NOTIFIER || "BAbASf5WlFkdMpNx33";
const DRY_RUN = process.argv.includes("--dry-run");

// Feeds whose SOURCE refreshes on its own: a long skip streak on them suggests
// a silently stale download. Quadratec AND keystone-ftp are left OUT: both read
// files COMMITTED into the image (the keystone FTP download is disabled in
// seed-all, found on Jul 24), so a continuous skip is the expected state, not
// staleness. Re-include keystone-ftp IF the runtime download comes back.
// meyer-ca/meyer-us only emit ingest_run after the stage+diff migration (until
// then the monitor stays silent: alertOnNoData=false).
const WATCHED_FEEDS = ["meyer-ca", "meyer-us"];

// Recipients of the e-mail notifier (INGEST_NOTIFIER). No hardcoded list: they
// come from INGEST_NOTIFIER_EMAILS or CRON_NOTIFICATION_EMAIL (single source in
// .env.production); local lists have already dropped a recipient twice (May and
// Jul 2026).
const NOTIFIER_EMAILS = String(process.env.INGEST_NOTIFIER_EMAILS || process.env.CRON_NOTIFICATION_EMAIL || "")
  .split(/[,\s]+/)
  .filter(Boolean);

// ensureNotifierEmails REMOVES anyone not in the list, so running with an empty
// list would wipe the notifier in Axiom. Abort before that happens.
if (NOTIFIER_EMAILS.length === 0) {
  console.error("NOTIFIER_EMAILS is empty: set INGEST_NOTIFIER_EMAILS or CRON_NOTIFICATION_EMAIL before running.");
  process.exit(1);
}

const monitors = [
  {
    // Matches the existing monitor by NAME (id 5joi92SRRX9oSrDBEg) -> PUT, no
    // duplicate. Redefined in Jul 2026: the old version ("zero events in 3min")
    // fired every night because /api/health is excluded from the logger and
    // night traffic drops to ~12 req/h, so empty windows were guaranteed. The
    // signal now is the absence of the 60s heartbeat that server.js emits
    // (logger.heartbeat), which is immune to traffic volume.
    name: "API Offline (P1)",
    type: "Threshold",
    description:
      "Zero heartbeats in 5min: a real outage of the process or of the log " +
      "pipeline (the app emits a heartbeat 1x/min; night traffic has no effect).",
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
    alertOnNoData: true, // no rows = no heartbeat = alert
    resolvable: true,
    notifierIds: [INGEST_NOTIFIER],
  },
  {
    name: "Ingest Feed Stale — só skips sem sucesso (P2)",
    type: "Threshold",
    description:
      "Alerts when an ingestion feed that should change (keystone/meyer) only " +
      "produces skipped-unchanged (0 success) for ~26h: possibly a silently " +
      "stale download. Quadratec is left out (committed file).",
    aplQuery: [
      `['${DATASET}']`,
      `| where type == "ingest_run" and feed in (${WATCHED_FEEDS.map((f) => `"${f}"`).join(", ")})`,
      `| summarize successes = countif(outcome == "success"), skips = countif(outcome == "skipped-unchanged") by feed`,
      `| where successes == 0 and skips > 0`,
      `| project feed, value = skips`,
    ].join("\n"),
    columnName: "value", // aggregated column the threshold is applied to
    operator: "AboveOrEqual",
    threshold: 2, // >=2 runs in the window, all skipped, zero success
    rangeMinutes: 1560, // ~26h: covers the 2 daily runs (06:00 and 19:00) with room to spare
    intervalMinutes: 60,
    alertOnNoData: false, // do not alert on a feed that simply did not run
    notifyByGroup: true, // one alert per feed (the `by feed` group)
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
    console.log(`✔ updated: ${def.name} (id ${existing.id})`);
    return;
  }
  const { data } = await api.post("/v2/monitors", def);
  console.log(`✔ created: ${def.name} (id ${data && data.id})`);
}

// Declarative (user decision, Jul 24): the notifier must hold EXACTLY the
// NOTIFIER_EMAILS, so it adds whoever is missing and REMOVES whoever is not in
// the list. GET -> compare -> PUT only if it changed, logging the delta.
async function ensureNotifierEmails(api, notifierId, emails) {
  const { data: notifier } = await api.get(`/v2/notifiers/${notifierId}`);
  const current = (notifier.properties && notifier.properties.email && notifier.properties.email.emails) || [];
  const desired = Array.from(new Set(emails));
  const same = current.length === desired.length && desired.every((e) => current.includes(e));
  if (same) {
    console.log(`✔ notifier ${notifierId} is already exactly: ${desired.join(", ")}`);
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
    (added.length ? ` | added: ${added.join(", ")}` : "") +
    (removed.length ? ` | removed: ${removed.join(", ")}` : "")
  );
}

async function main() {
  if (DRY_RUN) {
    console.log(`[dry-run] notifier ${INGEST_NOTIFIER} → ensure e-mails: ${NOTIFIER_EMAILS.join(", ")}`);
    for (const def of monitors) {
      console.log(`[dry-run] payload for: ${def.name}`);
      console.log(JSON.stringify(def, null, 2));
    }
    return;
  }

  if (!TOKEN) {
    console.error(
      "ERROR: AXIOM_MGMT_TOKEN is not set. It needs a PAT or API token with " +
        "monitor scope (the AXIOM_TOKEN used for ingestion does NOT work)."
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
      console.error(`✗ failed: ${def.name} — ${detail}`);
      process.exitCode = 1;
    }
  }
}

main();
