# JRP vendor feed: runbook

Design and decisions: [dd-020-jrp-vendor-feed.md](./design/dd-020-jrp-vendor-feed.md).
Feed platform (Spaces, catalog, panel, retention): [FEEDS.md](./FEEDS.md).

## What runs

JRP publishes `JUSJEE.csv` on its FTPS server every morning (seen written at 08:42 ET).
Two steps bring it in:

1. **Fetch** (`npm run feed-fetch-jrp`): downloads the file over explicit FTPS, checks it,
   uploads it to Spaces and catalogs it as the feed `jrp-ftp`. It never touches `VendorProduct`.
2. **Apply** (`npm run seed-jrp`): reads the current batch, matches the rows to our catalog
   and writes cost (CAD) and stock to `VendorProduct` for the vendor named `JRP`.

| Piece | File |
|---|---|
| Config and gates thresholds | `config/jrp.js` |
| Feed registration | `config/feeds.js` (`jrp-ftp`) |
| Brand labels | `jrp_code` on the rows of `prisma/seeds/hard-code_data/vendors_prefix.js` |
| FTPS client | `lib/feeds/ftpsClient.js`, `lib/feeds/explicitTlsConnect.js`, `lib/feeds/ftpsCa.js` |
| Fetch | `scripts/feed-fetch-jrp.js`, `services/feeds/jrpFetchService.js` |
| Apply | `prisma/seeds/seed-individual/seed-jrp.js`, `lib/feeds/jrp/*` |
| Crons (opt-in) | `config/cron-jobs.js` |
| Cron logs | `logs/feed-fetch-jrp.log`, `logs/feed-apply-jrp.log` |
| Run records | `IngestRun` with `feed = 'jrp-ftp-fetch'` (fetch) and `feed = 'jrp-ftp'` (apply) |
| Unmatched report | `reports/jrp-ftp/<runId>/unmatched.json` and `.csv` in the feeds bucket |
| Read-only probe | `scripts/jrp-ftp-probe.js` |

## How to run

```bash
npm run feed-fetch-jrp                    # FTPS -> Spaces -> catalog
npm run seed-jrp -- --dry-run             # read, match, gate, print; writes nothing
npm run seed-jrp                          # real apply
npm run seed-jrp -- --dry-run --force     # evaluate a file that was already applied
npm run feed-apply-jrp                    # what the cron runs: feed-sync -- jrp-ftp && seed-jrp
```

In production, through kamal (env loaded first):

```bash
set -a; source .env.production; set +a
kamal app exec 'npm run seed-jrp -- --dry-run'
```

From the panel: Settings page, Vendor Feeds card, `JRP (FTP)` row (triage users only).
"Fetch now" runs `feed-fetch-jrp`. "Run now" runs `feed-sync jrp-ftp` and then `seed-jrp`,
which is a **real** apply (there is no dry run from the panel). "Run now" refuses while the
scheduled `feed-apply-jrp` is running.

Options of `seed-jrp`:

| Flag | Effect |
|---|---|
| `--dry-run` | Reads only. Takes no lock, touches no staging table, creates no vendor, uploads no report, records no IngestRun. It still downloads the batch into the local feed cache. A gate failure still exits 1. |
| `--force` | Bypasses only the "same file" hash gate. Every other gate still applies. |

Exit codes: `0` success, skipped (same file) or lock held by another run; `1` failed (gate,
error, or Spaces not configured for a real run).

## Environment

Secrets, in `.env.production` (values) and passed through `.kamal/secrets` as `NAME=$NAME`:

| Name | Notes |
|---|---|
| `JRP_FTP_HOST` | required |
| `JRP_FTP_USER` | required |
| `JRP_FTP_PASS` | required |

The kamal `pre-build` hook aborts the deploy when one of these three is empty in the shell,
even while the crons are off.

Clear values in `config/deploy.yml` (`env.clear`): `JRP_FTP_PORT: "21"`, `JRP_FTP_MAX_ATTEMPTS: "10"`.

Optional (code defaults apply when unset, documented in `.env.example`):

| Name | Default | What |
|---|---|---|
| `CRON_FEED_FETCH_JRP_ENABLED` | off | fetch cron, on only when exactly `true` |
| `CRON_FEED_FETCH_JRP_SCHEDULE` | `20 9 * * *` | fetch schedule |
| `CRON_FEED_APPLY_JRP_ENABLED` | off | apply cron, on only when exactly `true` |
| `CRON_FEED_APPLY_JRP_SCHEDULE` | `50 9 * * *` | apply schedule |
| `JRP_FTP_PORT` | 21 | FTPS port |
| `JRP_FTP_MAX_ATTEMPTS` | 10 | consecutive attempts without progress |
| `JRP_FTP_RETRY_DELAY_MS` | 5000 | wait between attempts |
| `JRP_FTP_DOWNLOAD_DEADLINE_MS` | 2700000 | absolute download deadline (45 min) |
| `JRP_FTP_CA_PEM`, `JRP_FTP_CA_FILE`, `JRP_FTP_CA_OBJECT_KEY` | `certs/jrp-ftp-ca.pem` (object key) | pinned intermediate CA; without one it is fetched through AIA |
| `JRP_MIN_MATCHED` | 1500 | minimum matched rows; a value that is not a positive integer falls back to 1500 |
| `JRP_ACTIVE_BRANDS` | the 10 prefixes in `config/jrp.js` | comma separated `jj_prefix` list of brands to apply |
| `FEED_STALE_HOURS_JRP_FTP` | 36 | when the panel and digest call the feed stale |

Without a pinned CA, a fetch logs `ℹ️ No pinned CA at certs/jrp-ftp-ca.pem in the bucket` and
`⚠️ jrp intermediate CA not found (env or bucket), it will be fetched through AIA if the server omits it`,
then recovers the intermediate through AIA. Both lines are expected. Any other bucket error is
still a warning: `⚠️ Could not read certs/jrp-ftp-ca.pem from the bucket: <error>`.

## Daily schedule

| Time (default) | Job | Command |
|---|---|---|
| 9:20 | JRP FTP Feed Fetch | `feed-fetch-jrp` |
| 9:50 | JRP Prices Apply | `feed-apply-jrp` |

Both are off by default. If the fetch is still running at 9:50 the command gate defers the
apply. A file identical to the last one is skipped by its hash at both steps.

The 9:20 fetch rests on a single observed publish time (08:42 ET on 2026-10-27). After a week
of logged `published <ISO>` times, move the fetch later, or add a catch-up job like Keystone's
if JRP ever publishes late.

`seed-jrp` is **not** part of seed-all. It stays out until the first verified production run.

## First production run

1. Make sure `JRP_FTP_HOST`, `JRP_FTP_USER` and `JRP_FTP_PASS` are in `.env.production`, then deploy the back end.
2. "Fetch now" on the `JRP (FTP)` row (or `kamal app exec 'npm run feed-fetch-jrp'`). Check that a batch is catalogued.
3. `kamal app exec 'npm run seed-jrp -- --dry-run'`. Read the match counts, the sample and the gates line.
4. "Run now" on the same row (or `kamal app exec 'npm run feed-apply-jrp'`).
5. Check the IngestRun of feed `jrp-ftp` (`GET /api/ingest/runs?feed=jrp-ftp`): `status = success`, `rowsInserted` close to the matched count, `rowsDeleted = 0`. Open the report in Spaces (below).
6. Set `CRON_FEED_FETCH_JRP_ENABLED=true` and `CRON_FEED_APPLY_JRP_ENABLED=true` in `config/deploy.yml` (`env.clear`) and deploy.
7. Later, decide whether to add `seed-jrp` to seed-all (the commented line in `prisma/seeds/seed-individual/seed-all.js`).

The feed is registered in `config/feeds.js`, so the daily digest checks its freshness from the
deploy on. Without a catalogued batch it reports `jrp-ftp` as having no catalogued artifact
batch, and once the fetch cron stays off for more than `FEED_STALE_HOURS_JRP_FTP` (36h) it
reports it stale. Do step 2 right after the deploy and turn the fetch cron on the same day (or
raise `FEED_STALE_HOURS_JRP_FTP` until then), otherwise the digest email flags JRP every day.

## Expected log lines

Fetch, new file:

```
✅ Batch <batchId> catalogued with 1 file in <n>s
   JUSJEE.csv (<size>MB) -> <objectKey>
```

Fetch, same file: `⏭️  JRP feed identical to the current batch (<batchId>), nothing to upload (<n>s)`.

Apply, successful run:

```
[jrp] source batch=<batchId> sha=<sha8> file=<feed-cache path>/JUSJEE.csv
[jrp] parsed rows=<n> valid=<n> invalid=<n>
[jrp] match matched=<n> ambiguous=<n> unmatched=<n> skipped-inactive=<n>
[jrp] unmatched sample (25 of <n>): brand | JRPSKU | OEMSKU | reason
[jrp]   <brand> | <JRPSKU> | <OEMSKU> | <reason>
[jrp] gates ok: rows=<n> (last <n|none>), invalid=<n>, matched=<n> (min 1500)
[jrp] vendor JRP id=<id>
[jrp] applied staged=<n> inserted=<n> updated=<n> unchanged=<n> stale=<n> (listed only, nothing deleted)
[jrp] report json=reports/jrp-ftp/<runId>/unmatched.json csv=reports/jrp-ftp/<runId>/unmatched.csv
[jrp] done status=success parsed=<n> matched=<n> ambiguous=<n> unmatched=<n> invalid=<n> skipped-inactive=<n> map-below-cost=<n> inserted=<n> updated=<n> stale=<n> failures=0
```

The sample lists `no-brand-mapping` rows first, then rotates across brand labels in
alphabetical order, so each brand shows a few rows. The vendor line ends with ` (created)` on the very first run. When rows are invalid, the
parsed line lists the reasons (for example `bad-cost=N`).

Other apply lines:

| Line | Meaning |
|---|---|
| `[jrp] source identical to the last successful run (sha <sha8>): nothing to do` | run `skipped-unchanged` |
| `[jrp] another jrp-ftp run holds the lock: skipped` | another apply is running; exit 0 |
| `[jrp] DRY RUN: reads only, nothing is written, uploaded or recorded` | start of a dry run |
| `[jrp] DRY RUN: source identical to the last successful run, a real run would skip (add --force to evaluate it)` | dry run on the file already applied; nothing evaluated |
| `[jrp] DRY RUN: would stage <n> rows for vendor id=<id>` | end of a dry run (`JRP (to be created)` before the first real run) |
| `[jrp] FAILED (gate): <reason>` | a gate refused the apply, nothing written |
| `[jrp] FAILED: <message>` | any other failure |

Numbers seen on the 2026-10-27 file: 26,451 rows parsed, 0 invalid, 31 `map-below-cost`.

## Reading the IngestRun

Apply runs (`feed = 'jrp-ftp'`):

| Column | Value |
|---|---|
| `sourceKind` / `sourceRef` | `ftp-csv` / `JUSJEE.csv` |
| `sourceHash` / `artifactBatchId` | sha256 and batch of the file applied |
| `sourceRowCount` | rows parsed (the shrink gate compares with the last success) |
| `rowsInserted` / `rowsUpdated` | rows written |
| `rowsMarkedStale` | JRP rows in `VendorProduct` missing from the matched feed (listed only) |
| `rowsSkipped` | invalid + unmatched + skipped-inactive (1 on `skipped-unchanged`) |
| `rowsDeleted` | always 0 |
| `status` / `error` | `success`, `skipped-unchanged` or `failed` with the message |

Matched, ambiguous, `map-below-cost` and the invalid reasons have no column; they are in the
`done` log line and in the report's `counts`.

## When it fails

| Symptom | What happened | What to do |
|---|---|---|
| `❌ JRP feed fetch failed: ...` with a TLS, certificate or login error | FTPS handshake or credentials failed | Nothing was catalogued; the current batch stays and the apply keeps using it. Check the credentials and that the server is up. `scripts/jrp-ftp-probe.js` (below) tests the connection read-only. |
| `JRP_FTP_HOST missing from the environment` | env not loaded | Check `.env.production` and the deploy. |
| `JUSJEE.csv has <n> bytes (< minimum 500000), truncated download?` | file too small | Fetch refused; rerun "Fetch now" later. |
| `JUSJEE.csv shrank to <n> bytes (current batch has <n>, minimum 70%), truncated download?` | file much smaller than the current one | Fetch refused. If JRP really removed brands, check the file with the probe before anything else. |
| `JUSJEE.csv has an unexpected header. ...` | JRP changed its columns | Fetch refused. Follow "When a vendor changes its columns" in [FEEDS.md](./FEEDS.md), and check `lib/feeds/jrp/parseRow.js` still reads the new layout. |
| `JUSJEE.csv has <n> line(s) with an odd number of quotes ...` | stitched or corrupted download | Fetch refused; fetch again. |
| `Feed shrank: <n> rows parsed vs <n> in the last successful run ...` | apply shrink gate | Apply refused, nothing written. Look at the file before forcing anything. |
| `Too many invalid rows: X of Y (a%, maximum 2.00%) ...` | malformed file | Apply refused, nothing written. The parsed line lists the reasons. |
| `Feed has no data rows.` | empty file | Apply refused. |
| `Too few matches: <n> matched, threshold 1500 (JRP_MIN_MATCHED) ...` | matching broke or brands dropped | Apply refused, nothing written. Read the unmatched sample: many `no-brand-mapping` means JRP renamed a label; many `no-sku-match` means the part numbers changed. Lower `JRP_MIN_MATCHED` only if the drop is real and expected. |
| `Report upload failed after the apply (VendorProduct was written, a rerun is safe)` | Spaces failed after the write | Run the apply again; the rerun changes nothing in `VendorProduct` and uploads the report. |

## Reading the unmatched report

Each real apply writes, in the feeds bucket (`DO_SPACES_FEEDS_BUCKET`, falls back to `DO_SPACES_BUCKET`):

```
reports/jrp-ftp/<runId>/unmatched.json
reports/jrp-ftp/<runId>/unmatched.csv
```

`<runId>` is the IngestRun id of the apply. The CSV opens in a spreadsheet; its columns are
`list,brand_label,jrpsku,oemsku,product_sku,reason`:

| `list` | `reason` | Meaning |
|---|---|---|
| `unmatched` | `no-brand-mapping` | the `BRAND` label is on no `vendors_prefix.js` row (a brand we have not mapped yet) |
| `unmatched` | `no-sku-match` | brand known, but no product of that prefix has this part number |
| `ambiguous` | `ambiguous:<sku1>\|<sku2>` | applied, but more than one product had this part number: `product_sku` is the one the tie-break chose, the reason lists the others |
| `inactive` | `skipped-inactive` | brand mapped, but its prefix is not in the active list |
| `stale` | `missing-from-feed` | a JRP row in `VendorProduct` that is not in this feed; listed only, never deleted |

The JSON has the same lists (`unmatched`, `ambiguous`, `inactive`, `stale`) plus the run `counts`. These objects are outside the `feeds/`
prefix, so the retention prune never touches them, and nothing else deletes them either.

## Activating a new brand

When JRP approves one of the remaining brands, its rows appear in the report as
`no-brand-mapping`. To bring it in:

1. Copy the brand's `BRAND` label exactly as it appears in the report or the file.
2. Add `jrp_code: "<label>"` to that brand's existing row in `prisma/seeds/hard-code_data/vendors_prefix.js` (right after `brand_name`). That file belongs to a colleague: data-only change, minimal diff.
3. Add its `jj_prefix` to the active list: either `DEFAULT_ACTIVE_BRANDS` in `config/jrp.js`, or `JRP_ACTIVE_BRANDS` in the environment (the env list replaces the default, so it must name all the active prefixes).
4. If its part numbers carry a brand prefix like Airaid's `AIR`, add an entry to `OEM_STRIP` in `config/jrp.js`.
5. Run `npm test`, deploy, then `npm run seed-jrp -- --dry-run --force` and check the brand in the match counts.
6. A real apply of the same file is `skipped-unchanged`: the hash gate compares it with the last successful apply. The new brand is written by the next JRP file, or right away with `npm run seed-jrp -- --force` (in production `kamal app exec 'npm run seed-jrp -- --force'`).

## Turning it off

1. Set `CRON_FEED_FETCH_JRP_ENABLED=false` and `CRON_FEED_APPLY_JRP_ENABLED=false` in `config/deploy.yml` (`env.clear`) and deploy.
2. The JRP rows stay in `VendorProduct` with their last cost and stock. Nothing is zeroed or deleted automatically (team policy).
3. Never bulk delete JRP rows by hand without first checking `OrderProduct.vendor_product_id` for references: `OrderProduct.vendorProduct` is `onDelete: Cascade` (`prisma/schema.prisma`), so the delete also removes those order lines.

## Read-only probe

`scripts/jrp-ftp-probe.js` lists what the server exposes and, with `--download`, copies the
files to a local folder. It never writes to the database, to Spaces or to the server, and it
never prints the credentials.

```bash
set -a; source .env.production; set +a
node scripts/jrp-ftp-probe.js                          # list only
node scripts/jrp-ftp-probe.js --download --out <dir>   # list + download
```

## Password rotation

The FTP password was shared in the ticket. Ask JRP to rotate it. Put the new value only in
`.env.production` (`.kamal/secrets` already passes `JRP_FTP_PASS` through as `JRP_FTP_PASS=$JRP_FTP_PASS`),
then deploy the back end and run "Fetch now" to confirm the login.
