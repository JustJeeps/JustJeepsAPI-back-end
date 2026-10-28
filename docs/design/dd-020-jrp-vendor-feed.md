# DD-020: JRP Vendor Feed (FTPS to VendorProduct)

## Document Information

| Attribute | Value |
|-----------|-------|
| Version | 0.2.0 |
| Status | Built, reviewed, sandbox-verified and adversarially tested; not merged or deployed yet; crons off and seed-jrp out of seed-all until the first verified production run |
| Created | 2026-10-27 |
| Last Updated | 2026-10-28 |
| Author | Ricardo Tassio, with Claude Code |
| Runbook | [JRP_FEED.md](../JRP_FEED.md) |
| Feed platform | [FEEDS.md](../FEEDS.md) |
| Sibling | [dd-014-keystone-ftp.md](./dd-014-keystone-ftp.md) (the other FTPS vendor feed) |

## Context

JRP is a new Canadian distributor. It publishes one CSV a day on an FTPS server with its
cost and stock for the brands we were approved for on its portal. This feed brings that
file into Spaces, matches it to our catalog and writes the cost and stock as a vendor in
`VendorProduct`. Repo: `JustJeepsAPI-back-end`.

## 1. Why a Vendor and not a Competitor

The ticket asked for "a new competitor id". JRP is modelled as a Vendor instead:

- `VendorProduct` has cost, inventory, `cost_usd` and `retail_usd`. `CompetitorProduct` has only `competitor_price`.
- The order screen already loops over every vendor product to pick the best vendor and to show cost and margin. A new Vendor row shows up there with no front-end change.
- A wholesale cost shown as `competitor_price` would look like a rival undercutting us.

The "new id" part is met by resolving the Vendor row **by name** `JRP` (find or create). The
existing vendors are ids 1 to 17, so JRP will most likely get 18, but no code depends on that
number. On the first real run the apply creates the row with name `JRP`, website
`https://www.jrpdatapoint.com`, and placeholder `username`/`password` values (the columns are
required; no credential is stored there).

## 2. The remote file (discovery of 2026-10-27)

| Fact | Value |
|---|---|
| Protocol | Explicit FTPS (AUTH TLS) on port 21, passive mode |
| Certificate | The server omits its intermediate ("RapidSSL TLS RSA CA G1"); it is fetched through AIA (`lib/feeds/aiaIntermediate.js`) |
| File | One file at the root, `JUSJEE.csv`, about 2.9 MB, overwritten every morning (seen written at 08:42 ET). No Excel file. |
| Format | Quoted CSV, comma separated |
| Header | Exactly `BRAND,JRPSKU,OEMSKU,DESCRIPTION,IN-STOCK,COST,MAP` |
| Rows | 26,451, all with 7 columns, `JRPSKU` unique, no empty prices |
| `IN-STOCK` | Text: `0`, `1`, `2`, `3` or `4+` |
| Currency | CAD |
| `BRAND` | A plain label column, 10 labels today |

`JRPSKU` is JRP's 3-letter code plus `OEMSKU` (AFE, BIL, HUS, HOL, BOR, FLO, KCH, ARX).
For Energy Suspension and Airaid, `JRPSKU` equals `OEMSKU`. So `JRPSKU` is never used to
match; it is only the vendor's own key.

## 3. Brands

10 of the 25 brands in the ticket are in the file today. The other 15 were not approved on
JRP's portal yet.

Counts measured read-only on 2026-10-27 against the file of that day (26,451 rows) and the
production catalog (2,506 SKUs under the 10 prefixes), reproduced exactly by the sandbox run.

| JRP `BRAND` label | Code inside `JRPSKU` | Our `jj_prefix` | Our `brand_name` | Feed rows | Catalog SKUs | Matched |
|---|---|---|---|---|---|---|
| aFe Power | AFE | AFE | aFe Power | 7,083 | 57 | 48 |
| Airaid | none (the OEMSKU itself starts with AIR) | AIR | AIRAID | 381 | 33 | 11 |
| AlphaRex | ARX | ALR | AlphaRex | 583 | 407 | 388 |
| Bilstein | BIL | BIL | Bilstein | 5,219 | 794 | 749 |
| Borla Performance | BOR | BOR | Borla Performance | 1,673 | 723 | 670 |
| Energy Suspension | none | ESP | Energy Suspension | 3,423 | 199 | 155 |
| Flowmaster | FLO | FLM | FlowMaster | 926 | 43 | 39 |
| Holley | HOL | HOL | Holley | 1,911 | 1 | 0 |
| Husky Liners | HUS | HU | Husky Liners | 4,475 | 62 | 39 |
| KC HiLiTES | KCH | KCH | KC HILITES | 777 | 187 | 125 |

Total matched: 2,224. The code inside `JRPSKU` is listed for reading the file only; it is
never used to match (Flowmaster is FLO there and FLM here, Husky is HUS there and HU here).
`JRPSKU` is what we store as `vendor_sku`. Airaid has the strip rule of section 4. Holley is
mapped but has one catalog SKU, absent from the feed; it is also the brand whose part numbers
collide after the separators are dropped (`12-125` and `121-25`), which section 4 covers.

The label lives in a `jrp_code` field on the brand's row of
`prisma/seeds/hard-code_data/vendors_prefix.js`, verbatim from the file. The lookup is case
and whitespace insensitive (`brandLabelToPrefix` in `config/jrp.js`). A row may also carry a
`jrp_aliases` array if JRP ever writes the same brand two ways.

Which brands are applied is a separate list: `activeBrands(env)` in `config/jrp.js` returns
`JRP_ACTIVE_BRANDS` (comma separated `jj_prefix` values) or, when that is unset, the 10
prefixes above (`DEFAULT_ACTIVE_BRANDS`).

### What happens with the 15 brands not in the feed yet

Nothing is written for them. When JRP approves one and it appears in the file:

- If its row in `vendors_prefix.js` has no `jrp_code`, every row of that brand lands in the unmatched report with reason `no-brand-mapping`.
- If it has a `jrp_code` but its prefix is not in the active list, its rows are reported as `skipped-inactive`.
- Once both are in place, its rows are matched and written on the next apply.

How to add one is in the runbook: [Activating a new brand](../JRP_FEED.md#activating-a-new-brand).

## 4. Matching rule

```
BRAND label -> jrp_code on vendors_prefix -> jj_prefix
            -> products whose sku starts with "<jj_prefix>-"
            -> canonical OEMSKU == canonical searchable_sku
```

- Our catalog stores `Product.sku = jj_prefix + "-" + OEMSKU` and `Product.searchable_sku = OEMSKU` (for example `ALR-210081` / `210081`, `ESP-3.1108G` / `3.1108G`, `HU-13021` / `13021`).
- The comparison uses `lib/competitors/skuMatch.js`: the canonical form trims, upper-cases and strips `-`, `_` and spaces, and keeps dots.
- Products are loaded once per active prefix present in the file.
- **Airaid strip.** Airaid part numbers carry the brand letters (`AIR100-262` is our `AIR-100-262`). `OEM_STRIP` in `config/jrp.js` (`{ AIR: /^AIR/ }`) removes a leading `AIR` before matching. If the strip would leave nothing, the original value is used.
- **Ambiguous.** When two of our products have the same canonical part number, the row still counts as matched. The tie-break is: exact upper-case equality with `searchable_sku`, then the active product (`status = 1`), then the smaller sku.
- **Feed collision.** Two feed rows can land on one product, because the canonical form drops separators (today's file has six Holley pairs such as `12-125` and `121-25`). At most one row per product is written: the one whose part number equals the product's `searchable_sku` as written (or the sku minus its prefix). The others are listed as `feed-collision:kept=<JRPSKU>` in the report and counted as skipped. When no row is exact, or more than one is, nothing is written for that product and the whole group is listed as `feed-collision:unresolved`: separators are the only thing that tells `12-125` from `121-25`, and writing the cost of the wrong part is worse than writing nothing.
- No hit gives reason `no-sku-match` in the unmatched report.

Read-only match counts on 2026-10-27 (catalog SKUs with the prefix / matched): AlphaRex
407/388, Bilstein 794/749, Borla 723/670, ESP 199/155, KCH 187/125, aFe 57/48, FLM 43/39,
HU 62/39, Holley 1/0, Airaid 33/11.

The file is much larger than our catalog for these brands, so an "unmatched ratio" would
always look bad and says nothing. The apply gate is a **minimum matched count** instead.

## 5. What is written

One `VendorProduct` row per matched `JRPSKU`, keyed `(vendor_id, vendor_sku)`. A `JRPSKU`
repeated in the file is applied once, from its first copy in feed order; the other copies are
listed as `duplicate-jrpsku` in the report and counted as skipped. The `DISTINCT ON (jrpsku)`
in the stage stays as a safety net.

| Column | Value |
|---|---|
| `product_sku` | the matched `Product.sku` |
| `vendor_sku` | `JRPSKU` |
| `vendor_cost` | `COST`, in CAD |
| `vendor_inventory` | `IN-STOCK` as a number; `4+` is stored as 4 (`STOCK_PLUS_VALUE`) |
| `vendor_inventory_string` | the raw `IN-STOCK` text, so `4+` is still visible |

- **CAD only.** No USD conversion anywhere; the USD columns are not touched.
- **MAP is never written.** `VendorProduct` has no MAP column. MAP is still parsed and validated, and rows whose MAP is below cost are counted (`map-below-cost`, 31 on the 2026-10-27 file). JRP sends `-0.01` when a part has no MAP; those rows are kept and counted the same way.
- The rows go through an UNLOGGED staging table (`staging.vp_jrp_raw`, then `staging.vp_jrp_final` with `DISTINCT ON (jrpsku)`) and `lib/ingest/diffApply.js`, so a second run on the same file changes nothing.

### Stale rows: report only

`staleStrategy: 'none'`. A JRP row that is in `VendorProduct` but missing from the matched
feed is counted (`stale=` in the log, `rowsMarkedStale` on the IngestRun) and listed in the
report with reason `missing-from-feed`. It is not deleted, zeroed or changed. No step of this
feed ever deletes a row (`rowsDeleted` is always 0). Any clean-up is a manual decision.

## 6. Two steps, two runs

| Step | Command | IngestRun feed | Writes |
|---|---|---|---|
| Fetch | `feed-fetch-jrp` (`scripts/feed-fetch-jrp.js` -> `services/feeds/jrpFetchService.js`) | `jrp-ftp-fetch` | the file to Spaces and the `FeedArtifact` catalog. Never `VendorProduct`. |
| Apply | `seed-jrp` (`prisma/seeds/seed-individual/seed-jrp.js` -> `lib/feeds/jrp/jrpIngest.js`) | `jrp-ftp` | `VendorProduct` and the report in Spaces |

The fetch uses the generic FTPS client `lib/feeds/ftpsClient.js` (extracted from the Keystone
client, which kept its behaviour) in explicit mode, with the AUTH TLS adapter
`lib/feeds/explicitTlsConnect.js`. The apply reads the current batch through the standard
materializer, like the other feeds. The feed is registered in `config/feeds.js` as `jrp-ftp`
(label `JRP (FTP)`), so it shows in the Feeds panel with "Fetch now" and "Run now".

## 7. Gates

Every gate fails before anything is written.

### Fetch (`services/feeds/jrpFetchService.js`)

| Gate | Rule | Result |
|---|---|---|
| TLS or login | handshake, certificate chain (one AIA retry) or credentials fail | run `failed`, catalog untouched, current batch stays |
| Minimum size | file smaller than `MIN_FILE_BYTES` (500,000) | refused |
| Shrink | file smaller than `MIN_SIZE_RATIO` (70%) of the current batch's file | refused |
| Header | header is not exactly `EXPECTED_COLUMNS`, in order | refused |
| Quote parity | a line with an odd number of quotes (stitched download) | refused |
| Same file | sha256 equal to the current batch | `skipped-unchanged`, nothing uploaded |

### Apply (`lib/feeds/jrp/jrpGates.js`, `lib/feeds/jrp/jrpIngest.js`)

| Gate | Rule | Result |
|---|---|---|
| Same file | sha256 equal to the last successful apply | `skipped-unchanged` (`--force` bypasses only this gate) |
| Quote parity | a line with an odd number of double quotes (the fetch runs the same check, the panel and CLI uploads do not) | `failed`, nothing written |
| Shrink | rows parsed below 70% of `sourceRowCount` of the last successful run | `failed`, nothing written |
| Empty | no data rows | `failed`, nothing written |
| Invalid ratio | invalid rows above `MAX_INVALID_RATIO` (2%) | `failed`, nothing written |
| Minimum matched | matched rows below `JRP_MIN_MATCHED` (default 1500) | `failed`, nothing written |

A row is invalid when `BRAND`, `JRPSKU` or `OEMSKU` is empty, `IN-STOCK` is not `0` to `3`
or `4+`, `COST` is not a non-negative number, or `MAP` is not a number. The reasons are
`missing-brand`, `missing-jrpsku`, `missing-oemsku`, `bad-stock`, `bad-cost`, `bad-map`.
`minMatched(env)` only accepts a positive integer; anything else falls back to 1500, so the
gate cannot be switched off by a typo.

On 2026-10-27 the 10 brands matched about 2,200 rows, so 1500 leaves room for normal
variation while still catching a broken match or a near-empty file.

## 8. The unmatched report

Each real apply uploads two objects to the feeds bucket:

```
reports/jrp-ftp/<runId>/unmatched.json
reports/jrp-ftp/<runId>/unmatched.csv
```

They hold three lists: `unmatched` (reasons `no-brand-mapping`, `no-sku-match`), `inactive`
(`skipped-inactive`) and `stale` (`missing-from-feed`). The JSON also has the run counts.
The key is built from the run id, because IngestRun has no column to store it.

They live **outside** the `feeds/` prefix on purpose: the retention prune deletes uncatalogued
objects under `feeds/<feed>/` after 24 hours, and only looks inside `feeds/`. Nothing deletes
these reports; they grow by one small pair per run.

## 9. Scheduling and rollout

| Job | Command | Default schedule | Flag (off unless exactly `true`) |
|---|---|---|---|
| JRP FTP Feed Fetch | `feed-fetch-jrp` | `20 9 * * *` | `CRON_FEED_FETCH_JRP_ENABLED` |
| JRP Prices Apply | `feed-apply-jrp` (`feed-sync -- jrp-ftp && seed-jrp`) | `50 9 * * *` | `CRON_FEED_APPLY_JRP_ENABLED` |

JRP writes the file around 08:42 ET. The fetch at 9:20 stays apart from the Keystone fetch at
9:30. If the fetch is still running at 9:50 the command gate defers the apply. An unchanged
file is skipped by its hash at both steps.

`seed-jrp` is deliberately **not** in seed-all. It stays out until the first verified
production run; the crons stay off until then too. The steps are in the runbook:
[First production run](../JRP_FEED.md#first-production-run).

## 10. Open items

- Ask JRP to rotate the FTP password; it was shared in the ticket.
- Turn the two crons on after the first verified run, then decide about adding `seed-jrp` to seed-all.
- The reports have no retention; revisit if the `reports/jrp-ftp/` folder grows too much.
- The other 15 brands, as JRP approves them.
- Low findings of the adversarial test left open on purpose (section 11): a `COST` of `0` is accepted and written; the Airaid strip is case sensitive; an error while releasing the lock or closing the stage pool after a successful apply makes `seed-jrp` exit 1; `JRP_MIN_MATCHED` accepts `0x10` and `1e3`; the dedupe keeps the first copy of a repeated `JRPSKU` even when only a later copy would match; a quoted `DESCRIPTION` with an embedded newline fails the quote parity gate (fetch and apply); `IN-STOCK` outside `0` to `3` and `4+`, or an empty `MAP`, is invalid, so a format change on more than 2% of the rows stops the feed.
- A catch-up fetch, after a week of logged publish times (final review item #6).
- `rowsMarkedStale` in the panel reads as if acted on (listed only) and a `skipped-locked` apply exits 0 (final review items #7 and #8, parked).

## 11. Process record (for audit)

How this feed was built and checked, with pointers to the evidence. The step-by-step
ledger, with every ruling and every deferred finding, is
[2026-10-27-jrp-vendor-feed-ledger.md](../plans/2026-10-27-jrp-vendor-feed-ledger.md).

### Steps

1. **Plan** approved on 2026-10-13, turned into the task plan
   [2026-10-27-jrp-vendor-feed.md](../plans/2026-10-27-jrp-vendor-feed.md) after a read-only
   discovery of the real server and file on 2026-10-27 (`scripts/jrp-ftp-probe.js`).
2. **Implementation** on branch `feat/jrp-vendor-feed` from `main` `e336c75`, seven tasks, one
   fresh Opus implementer per task and an Opus reviewer after each task (spec compliance and
   code quality), then one Opus review of the whole branch, one fix wave and a scoped
   re-review. Front end on `feat/jrp-export-columns` from `master` `cb57e75`.
3. **Sandbox verification** on 2026-10-27 against a throwaway Postgres (port 5456) holding
   the 2,506 production Product rows of the 10 prefixes, copied read-only: real FTPS fetch,
   dry run (26,451 parsed, 0 invalid, 2,224 matched, 89 ambiguous, 31 map below cost, nothing
   written), real apply (vendor JRP created, 2,224 inserted), rerun skipped by hash in 1 ms,
   forced rerun 0 inserted and 0 updated. The production database was never written.
4. **Adversarial test** on 2026-10-27, after the final review: an independent Opus agent ran
   hostile inputs against the real modules (CSV shape, values, matching, gates, orchestration
   through the fake world, fetch gates, injection), and the file of the day was profiled.
   No critical finding, no unwanted write. Four medium findings were fixed the same day:
   feed collisions (commits `925c7f5`, `441c62c`), duplicate `JRPSKU` (`f4e3c69`), BOM or
   spaces in the header (`1fdc337`), quote parity on apply (`2648ec8`). An Opus review of
   those fixes added `4d661ab` (stale reason for collision losers) and `7eb5e31` (tests).
   Branch HEAD after this: `7eb5e31`, 32 commits, 833 tests, 828 pass, 5 pre-existing skips.
5. **Not done at the time of writing:** merge, deploy, first production run.

### Rulings taken during the build

- JRP is a vendor, resolved by name, never by id; no migration (shared production database).
- Only the 10 brands in the real file are mapped; the ticket's other 15 wait for the feed.
- The apply gate is a minimum matched count (1,500), not an unmatched ratio.
- `MAP` is parsed, validated and counted, never written; `-0.01` means no MAP.
- Stale rows keep their last cost and stock; nothing is deleted or zeroed by a job (team policy).
- Reports live under `reports/jrp-ftp/<runId>/`, outside the `feeds/` retention prefix; nothing prunes them.
- `seed-jrp` stays out of `seed-all` and both crons are born off: the first production run is manual.
- Feed collisions: at most one row per product, only an exact row is written, otherwise nothing.
- Duplicate `JRPSKU`: first copy in feed order wins; the rest are reported.
- The sandbox used the real FTP and the real bucket; three small orphan report folders (`reports/jrp-ftp/2`, `/4`, `/6`) were accepted.

### Rules that an auditor can check in code

| Rule | Where | Test |
|---|---|---|
| Brand label to prefix, case and whitespace insensitive | `config/jrp.js` `brandLabelToPrefix` | `test/config/jrp.test.js` |
| Active brands, env override | `config/jrp.js` `activeBrands` | `test/config/jrp.test.js` |
| Row validation and the `4+` stock | `lib/feeds/jrp/parseRow.js` | `test/lib/feeds/jrp/parseRow.test.js` |
| BOM and header trim | `lib/ingest/streamCsv.js`, `lib/feeds/jrp/readFeed.js` | `test/lib/ingest/streamCsv.test.js`, `readFeed.test.js` |
| Duplicate `JRPSKU` | `lib/feeds/jrp/dedupeRows.js` | `test/lib/feeds/jrp/dedupeRows.test.js` |
| Part number match, Airaid strip, catalog tie-break, feed collisions | `lib/feeds/jrp/matchRows.js`, `lib/competitors/skuMatch.js` | `test/lib/feeds/jrp/matchRows.test.js` |
| Gates, all before any write | `lib/feeds/jrp/jrpGates.js`, `lib/feeds/jrp/jrpIngest.js` | `jrpGates.test.js`, `jrpIngest.test.js` |
| Staged diff, `staleStrategy: 'none'`, stale listing | `lib/feeds/jrp/jrpWrite.js` | `jrpIngest.test.js` (fake world) |
| Report bodies and keys | `lib/feeds/jrp/unmatchedReport.js` | `unmatchedReport.test.js` |
| Fetch gates (size, shrink, header, quote parity) | `services/feeds/jrpFetchService.js` | `test/services/feeds/jrpFetchService.test.js` |
| Crons off by default | `config/cron-jobs.js` | `test/config/cronJobs.test.js` |
