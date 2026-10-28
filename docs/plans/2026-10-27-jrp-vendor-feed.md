# JRP vendor feed: execution plan

Source plan (approved 2026-10-13): `~/.claude/plans/i-d-like-you-to-pure-fern.md`. This file turns it into tasks and folds in what the 2026-10-27 discovery found. Where the two disagree, THIS file wins.

## Discovery facts (2026-10-27, binding)

- Remote: explicit FTPS (AUTH TLS, port 21, PASV), host/user/pass in env `JRP_FTP_HOST`, `JRP_FTP_USER`, `JRP_FTP_PASS`, optional `JRP_FTP_PORT` (default 21). Server omits its intermediate certificate; `lib/feeds/aiaIntermediate.js` fetches "RapidSSL TLS RSA CA G1" via AIA. The working probe `scripts/jrp-ftp-probe.js` already does this handshake (see `explicitFtpsTlsConnect`).
- One file at root: `JUSJEE.csv`, about 2.9 MB, overwritten every morning (seen written 08:42 ET). No Excel file was present. A local copy is at `/private/tmp/claude-501/-Users-ricardotassio-DEV-TRABALHO-JUSTJEEPS/c0b870f4-d736-46c6-8d2e-7b5c1e3d74fc/scratchpad/jrp-feed/JUSJEE.csv` (read only, for fixtures).
- Layout: quoted CSV, comma, header exactly `BRAND,JRPSKU,OEMSKU,DESCRIPTION,IN-STOCK,COST,MAP`. 26,451 rows, all 7 columns, JRPSKU unique, no empty prices, 31 rows where MAP < COST (keep them, just count).
- `IN-STOCK` is a string: `0`, `1`, `2`, `3` or `4+`. `4+` means at least 4; store 4. Anything else is invalid.
- Currency: CAD. No USD conversion anywhere.
- `BRAND` is a plain label column (no sections). 10 brands present: `aFe Power`, `Bilstein`, `Husky Liners`, `Energy Suspension`, `Holley`, `Borla Performance`, `Flowmaster`, `KC HiLiTES`, `AlphaRex`, `Airaid`. The other 15 brands from the ticket were not approved on JRP's portal yet.
- `JRPSKU` = JRP 3-letter code + `OEMSKU` (AFE, BIL, HUS, HOL, BOR, FLO, KCH, ARX); Energy Suspension and Airaid have `JRPSKU == OEMSKU`. Never match on JRPSKU.
- Our catalog: `Product.sku = jj_prefix + "-" + OEMSKU`, `Product.searchable_sku = OEMSKU` (e.g. `ALR-210081` / `210081`, `ESP-3.1108G` / `3.1108G`, `HU-13021` / `13021`). Matching uses `lib/competitors/skuMatch.js` (canonical form strips `-_ ` and keeps dots) over the products whose sku starts with `jj_prefix + "-"`.
- Our prefixes for the 10 brands: AFE, BIL, HU, ESP, HOL, BOR, FLM, KCH, ALR, AIR. Airaid OEMSKU embeds the letters `AIR` (e.g. `AIR100-262`); strip a leading `AIR` before matching (config `oemStrip`).
- Read-only match counts on 27/10 (catalog SKUs with prefix / matched): AlphaRex 407/388, Bilstein 794/749, Borla 723/670, ESP 199/155, KCH 187/125, aFe 57/48, FLM 43/39, HU 62/39, Holley 1/0, Airaid 33/11. The feed is much larger than our catalog, so "unmatched ratio" is meaningless; the apply gate is a MINIMUM MATCHED COUNT (`minMatched`, default 1500).
- Existing vendors: ids 1..17, JRP is not there. Resolve by name "JRP" (find or create), never by id.

## Global constraints

- All code, comments, docs, tests and commit messages in English. Plain language, no em-dashes.
- Never touch the shared database from tests: every test uses injected stubs, mocked prisma and a silent logger (`node:test`). The runner breaks if a library logs to stdout; inject `log`.
- Never delete or zero vendor rows automatically: `staleStrategy: 'none'`; stale rows are counted and reported only.
- Immutability: return new objects, do not mutate inputs. Small focused files (under 400 lines), functions under 50 lines, early returns, named constants.
- No credential values anywhere in the repo. Env names only.
- `scripts/`, `services/feeds/`, `lib/feeds/`, `lib/ingest/`, `config/`, `prisma/seeds/seed-individual/` follow the existing Keystone pattern: thin script -> service -> pure lib.
- `prisma/seeds/hard-code_data/vendors_prefix.js` and `seed-allProducts.js` belong to a colleague: data-only additions, minimal diff, no reformatting.
- Run `npm run lint && npm test` before each commit. Conventional Commits, one logical change per commit, no mixed commits.
- Keystone's daily fetch must keep identical behaviour; its tests stay untouched and green.

## Task 1: Brand map and JRP config

Files: `prisma/seeds/hard-code_data/vendors_prefix.js` (data only), `config/jrp.js` (new), `test/config/jrp.test.js` (new).

- In `vendors_prefix.js`, add a `jrp_code` field holding JRP's `BRAND` label, verbatim, to the existing rows of the 10 brands: aFe Power (prefix AFE, row near line 140), AIRAID (AIR, ~155), AlphaRex (ALR, ~222), Bilstein (BIL, ~640), Borla Performance (BOR, ~759), Energy Suspension (ESP, ~1429), FlowMaster (FLM, ~1649), Holley (HOL), Husky Liners (HU), KC HiLiTES (KCH). Find each row by `jj_prefix`. Add nothing else to that file: no rows for brands that are not in the feed (there is no evidence of their label), no `Product` column.
- `config/jrp.js`, pure module in the style of `config/tdot.js`, exporting: `VENDOR_NAME = 'JRP'`, `VENDOR_WEBSITE` (`https://www.jrpdatapoint.com`), `FEED_ID = 'jrp-ftp'`, `REMOTE_FILE = 'JUSJEE.csv'`, `EXPECTED_COLUMNS` (the 7 header names in order), `MIN_FILE_BYTES` (500_000), `MIN_SIZE_RATIO` (0.7), `MIN_MATCHED` (1500, env `JRP_MIN_MATCHED`), `MAX_INVALID_RATIO` (0.02), `STOCK_PLUS_VALUE` (4, for `4+`), `OEM_STRIP` map (`{ AIR: /^AIR/ }` keyed by jj_prefix), and `activeBrands(env)` returning the active jj_prefix list: default the 10 prefixes above, overridable by env `JRP_ACTIVE_BRANDS` (comma separated, trimmed, upper-cased, empty entries dropped). Also export `brandLabelToPrefix(vendorsPrefix)` building a Map from lower-cased trimmed `jrp_code` to `jj_prefix` (and optional `jrp_aliases` array if present). No env reads at module load except through functions that receive `env`.
- Tests: active brands default and override, alias/label map (case and whitespace insensitive, rows without jrp_code ignored), constants present.

## Task 2: Generic FTPS client extracted from keystoneFtp

Files: `lib/feeds/ftpsClient.js` (new), `lib/feeds/keystoneFtp.js` (becomes a thin wrapper), `test/lib/feeds/ftpsClient.test.js` (new), `scripts/jrp-ftp-probe.js` (commit it as is in a separate `chore:` commit, read-only tool, no changes needed).

- Read `lib/feeds/keystoneFtp.js` and its tests under `test/lib/feeds/` first. Move the generic parts (retry/resume/deadline loop, size check, lastMod, PASV via `enterPassiveModeIPv4`, CA bundle, AIA intermediate hook) into `ftpsClient.js` parametrised by `{ secure: true | 'implicit', envPrefix, label, host, port, user, password, rejectUnauthorized, log }`.
- Explicit mode (`secure: true`) must do AUTH TLS on a plain socket and, when the server omits its intermediate, fetch it via AIA the way `scripts/jrp-ftp-probe.js` does (`explicitFtpsTlsConnect`). Reuse, do not duplicate; the probe may keep its own copy for now.
- `keystoneFtp.js` keeps its public API and behaviour exactly (implicit TLS on 990, same env names, same log lines). Its existing tests stay untouched and green.
- Tests for `ftpsClient`: explicit vs implicit selection, PASV used, resume on retry, certificate rejected surfaces an error, deadline respected. Inject a fake basic-ftp client.

## Task 3: JRP fetch service, script and feed registration

Files: `services/feeds/jrpFetchService.js` (new), `scripts/feed-fetch-jrp.js` (new), `config/feeds.js` (add `jrp-ftp`), `test/services/feeds/jrpFetchService.test.js` (new), `test/lib/feedsConfig.test.js` (extend if it enumerates feeds).

- Mirror `services/feeds/keystoneFetchService.js` and `scripts/feed-fetch-keystone.js` one to one, for a single file `JUSJEE.csv`: mark a leftover `running` IngestRun as failed; IngestRun feed `jrp-ftp-fetch`; download with `ftpsClient` (`secure: true`, port from env `JRP_FTP_PORT` default 21, `rejectUnauthorized: true`); gates before cataloguing: minimum bytes, header equals `EXPECTED_COLUMNS` exactly, CSV quote parity; sha256 equal to the current batch => `skipped-unchanged`, nothing uploaded; upload via `lib/feeds/feedStore.js` then `catalog.registerArtifacts`; warm the local cache; a failed fetch leaves the catalog untouched.
- `config/feeds.js`: add a `jrp-ftp` entry modelled on `keystone-ftp` with `fetch: 'ftp'`, `fetchCommand: 'feed-fetch-jrp'`, `seedCommand: 'seed-jrp'`, `recordsOwnRuns: true`, `legacyDir: 'jrp_files'`, `staleAfterHours: 36`, column signature = `EXPECTED_COLUMNS` from `config/jrp.js`, one expected file.
- Tests: dedup skip, size gate, header gate, quote parity gate, failure leaves catalog untouched, success registers artifacts. Injected stubs only.

## Task 4: seed-jrp apply script

Files: `prisma/seeds/seed-individual/seed-jrp.js` (thin script), `lib/feeds/jrp/` (new folder: `parseRow.js`, `matchRows.js`, `jrpIngest.js`, `unmatchedReport.js`, each small and pure where possible), `test/seeds/seedJrp.test.js` and `test/lib/feeds/jrp/*.test.js` (new).

- Study first: `prisma/seeds/seed-individual/seed-keystone-ftp-2.js`, `prisma/seeds/seed-individual/seed-meyer-us.js` (lines ~312-560), `lib/ingest/streamCsv.js`, `lib/ingest/stageTable.js`, `lib/ingest/diffApply.js`, `lib/ingest/ingestRun.js`, `lib/ingest/fileHash.js`, `lib/competitors/skuMatch.js`, `lib/feeds/feedStore.js`, and the Lowriders unmatched sampling in `lib/competitors/lowridersIngest.js` (~lines 103-104).
- Flow: resolve the current `jrp-ftp` artifact from the catalog (same helper Keystone uses), hash gate `isUnchanged` => skip; shrink guard against the last applied row count (`MIN_SIZE_RATIO`); stream the CSV into an UNLOGGED stage table; `DISTINCT ON (jrpsku)`; resolve the Vendor by name `VENDOR_NAME` (find or create, like `seed-daily-premier.js` ~281-290).
- `parseRow`: pure. Returns `{ ok: true, row }` or `{ ok: false, reason }`. Rules: brand label trimmed; OEMSKU required; `IN-STOCK` in `{0,1,2,3}` or `4+` (=> `STOCK_PLUS_VALUE`), else invalid; COST and MAP parse as finite non-negative numbers, else invalid; keep `map` as a separate field (not written to VendorProduct unless a field exists for it; check schema and only write existing columns).
- `matchRows`: pure. Brand label -> `jj_prefix` via `brandLabelToPrefix`; missing => reason `no-brand-mapping`; prefix not in `activeBrands` => `skipped-inactive`; apply `OEM_STRIP[prefix]` if any; match with `buildProductIndex` over the products whose sku starts with `prefix + "-"` (load once per prefix, select sku, searchable_sku, status) and `matchPartNumber`; ambiguous counts as matched with the tie-break; no hit => `no-sku-match`.
- Write with `diffApply` keyed on `(vendor_id, vendor_sku)` where `vendor_sku` = JRPSKU, product sku from the match, cost and inventory from the row, `staleStrategy: 'none'`. Stale rows (in DB for this vendor, missing from the feed) are counted and listed only. Second run on the same file changes nothing.
- Gates: invalid ratio above `MAX_INVALID_RATIO` fails the run before writing; matched count below `MIN_MATCHED` fails the run before writing (log the number and the threshold).
- `--dry-run`: everything except the write and the catalog/run bookkeeping of a real apply; still prints counts and the sample. Still records an IngestRun flagged dry run only if the existing helpers support it; otherwise skip recording in dry run.
- Record the run with `lib/ingest/ingestRun.js`: files downloaded, rows parsed, matched, unmatched, invalid, inserted, updated, stale, skipped-inactive, map-below-cost, failures.
- Unmatched report: log a sample of 25 unmatched lines; write the full unmatched, stale and inactive lists as JSON and CSV to Spaces at `feeds/jrp-ftp/reports/<runId>/` through `feedStore`, store the key on the run (use an existing field if one exists, otherwise in the run's notes/meta field; check `ingestRun.js` and the schema). Each unmatched line: brand label, JRPSKU, OEMSKU, reason.
- Tests (mocked prisma, injected stubs, silent logger): parseRow all branches (`4+`, bad stock, bad cost, missing OEMSKU); matching with alias and case differences; Airaid strip; inactive brand skipped; brand not mapped reported; idempotent rerun (no changes on second apply); nothing deleted on stale; invalid ratio gate; min matched gate; report content and key; dry run writes nothing.

## Task 5: Wiring (scripts, seed-all, cron, env names)

Files: `package.json`, `prisma/seeds/seed-individual/seed-all.js`, `config/cron-jobs.js`, `.env.example`, `.kamal/secrets`, `config/deploy.yml`, and the cron verification test if it enumerates jobs (`npm run verify-cron`).

- `package.json`: `feed-fetch-jrp` (`node scripts/feed-fetch-jrp.js`), `seed-jrp` (`node prisma/seeds/seed-individual/seed-jrp.js`), `feed-apply-jrp` chained like `feed-apply-keystone` (`npm run feed-sync -- jrp-ftp && npm run seed-jrp`).
- `seed-all.js`: add `seed-jrp` to `otherSeeds`.
- `config/cron-jobs.js`: `feed-fetch-jrp` gated by `CRON_FEED_FETCH_JRP_ENABLED` (default off) with `CRON_FEED_FETCH_JRP_SCHEDULE` default `20 9 * * *` (JRP writes about 08:42 ET, Keystone fetches at 09:30; keep them apart), and `feed-apply-jrp` gated by `CRON_FEED_APPLY_JRP_ENABLED` default off, schedule `CRON_FEED_APPLY_JRP_SCHEDULE` default `50 9 * * *`, both through the existing `commandGate`, with `reportLogFile` like the Keystone entries.
- Env names only: `.env.example` (documented block like the Keystone one: `JRP_FTP_HOST`, `JRP_FTP_PORT`, `JRP_FTP_USER`, `JRP_FTP_PASS`, optional `JRP_FTP_CA_PEM`, `JRP_FTP_MAX_ATTEMPTS`, `JRP_FTP_RETRY_DELAY_MS`, `JRP_MIN_MATCHED`, `JRP_ACTIVE_BRANDS`, the two cron flags and schedules, `FEED_STALE_HOURS_JRP_FTP`); `.kamal/secrets` (`NAME=$NAME` for host, port, user, pass); `config/deploy.yml` `env.secret` (host, user, pass) and `env.clear` for `JRP_FTP_PORT: "21"` and `JRP_FTP_MAX_ATTEMPTS`.
- `npm run lint && npm test` green (test also runs `verify-cron-scripts`).

## Task 6: Documentation

Files: `docs/design/dd-020-jrp-vendor-feed.md` (new), `docs/JRP_FEED.md` (new runbook), `docs/FEEDS.md` (add the feed).

- Design doc: why Vendor and not Competitor; the real file layout; matching rule (label -> prefix -> searchable_sku, Airaid strip); `4+`; stale handling (`none`, report only); CAD; gates (min bytes, header, min matched, invalid ratio, shrink); what happens with the 15 brands not yet in the feed.
- Runbook: manual run (`npm run feed-fetch-jrp`, `npm run seed-jrp -- --dry-run`, `npm run seed-jrp`, or "Fetch now" / "Run now" in the Feeds panel), env vars, daily schedule and how to turn the crons on, expected log lines, failure modes (TLS/login: fetch fails and the current batch stays; shrunk or malformed feed: apply refused; too few matches: apply refused), how to activate a new brand (`jrp_code` in vendors_prefix plus `JRP_ACTIVE_BRANDS` or the config default), how to read the unmatched report in Spaces, the password rotation request.
- Check the existing docs style under `docs/` and follow it. Plain English, no em-dashes.

## Task 7: Front end export columns (separate repo)

Repo: `/Users/ricardotassio/DEV/TRABALHO/JUSTJEEPS/JustJeepsAPI-front-end` (branch `feat/jrp-export-columns` from `master`). Files: `src/features/items/Items.jsx` (Excel export near lines 378-415 and 462-600) and its tests.

- Add "JRP Cost" and "JRP Inventory" columns to the Excel export, following exactly how the other vendors' columns are produced there (vendor name match `JRP`). No restyling, no new UI, nothing else.
- `npm run lint && npm test` green. One `feat:` commit. Do not push.
