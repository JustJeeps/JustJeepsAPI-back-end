# JRP vendor feed: execution ledger (audit record)

This is the controller's ledger of the subagent-driven build of the JRP feed, kept as it was
written during the work, plus the entries added after it (final review, adversarial test,
fixes). One line per event: dispatches, reviews, rulings (`Ruling: what - why - cost if wrong`)
and the minors each review deferred. Commit hashes are on the `feat/jrp-vendor-feed` branch.
The design is in [dd-020](../design/dd-020-jrp-vendor-feed.md), the task plan in
[2026-10-27-jrp-vendor-feed.md](./2026-10-27-jrp-vendor-feed.md).

# SDD ledger - plan: docs/plans/2026-10-27-jrp-vendor-feed.md
Spec: ~/.claude/plans/i-d-like-you-to-pure-fern.md (approved 2026-10-13) plus discovery facts of 2026-10-27 folded into the plan file. Plan file wins on conflicts.
Branch: feat/jrp-vendor-feed from main e336c75. Implementer/reviewer model: opus (user request).

## Preflight scan
| Pair / task | Produces vs consumes | Finding |
| T1 -> T4 | config/jrp.js exports activeBrands, brandLabelToPrefix, OEM_STRIP, MIN_MATCHED, STOCK_PLUS_VALUE; T4 consumes them | consistent |
| T1 -> T3 | EXPECTED_COLUMNS used as feeds.js signature | consistent |
| T2 -> T3 | ftpsClient({secure:true,...}) consumed by jrpFetchService | consistent |
| T3 -> T5 | feeds.js seedCommand 'seed-jrp', fetchCommand 'feed-fetch-jrp' vs package.json names | consistent |
| T4 -> T5 | seed-jrp.js path vs package.json script | consistent |
| T3 -> T4 | catalog artifact id 'jrp-ftp' written by fetch, read by apply | consistent |
| T1 self | data-only edit to colleague file; no Product column | consistent with constraints |
| T4 self | tests mock prisma; stage table helper needs prisma raw; tests must stub the stage helpers | note for implementer |
| T7 | separate repo, separate branch | no overlap |
Scan clean. Ruling: source plan's 25-brand map, 18-brand prefix check, USD branch and Excel file handling are dropped - the feed has 10 brands, CAD, CSV only - cost if wrong: a later brand needs a one-line jrp_code addition.
Ruling: apply gate is a minimum matched count, not an unmatched ratio - feed is 26k rows vs ~2.5k catalog SKUs - cost if wrong: a bad feed with >=1500 accidental matches could apply; shrink + header gates still stand.

## Execution
Task 1: implemented (commits 148b39e..34db2de: 21efefe, 34db2de), DONE_WITH_CONCERNS: no `lint` script in back end (only `npm test`); minMatched(env) function added beside MIN_MATCHED; DEFAULT_ACTIVE_BRANDS exported. Review dispatched.
Ruling: back end has no lint script, so the plan's "npm run lint && npm test" means `npm test` here - cost if wrong: none, lint only exists on the front end.
Task 1: review clean. Controller checked ⚠️ items: labels verified against the real JUSJEE.csv brand counts on 27/10 (verbatim); style parity not load-bearing.
Task 1: minor (deferred): brandLabelToPrefix keeps the last duplicate label silently (config/jrp.js:63-71); consider throwing on duplicates.
Task 1: minor (deferred): activeBrands override not validated/deduplicated against known prefixes (config/jrp.js:49-55).
Task 1: minor (deferred): two tests cover less than their names say (test/config/jrp.test.js:322-340).
Task 1: complete (commits 148b39e..34db2de, review clean)
Task 2: BASE 34db2de, dispatched (opus).
Task 2: implemented (commits 34db2de..HEAD: 2a857c3 probe, 785e556 explicitTlsConnect, bc74ee0 ftpsClient + ftpsCa + keystoneFtp wrapper), DONE_WITH_CONCERNS: shared certs/aia cache across vendors (public intermediates, root-validated); "jrp intermediate CA not found" log until a JRP CA object exists; createFtpsClient ~85 lines mostly parameter docs. Review dispatched.
Task 2: review clean. Controller checked ⚠️: `git diff --name-only 34db2de..bc74ee0 -- test/lib/feeds/keystone*` is empty (Keystone tests untouched); real-server AUTH TLS will be verified live in the final dry run.
Task 2: minor (deferred): createFtpsClient ~85 lines (lib/feeds/ftpsClient.js:353-437); hoist the loop to runDownloadLoop.
Task 2: minor (deferred): `defaults` with an undefined field yields NaN attempts (lib/feeds/ftpsClient.js:205); callers must not forward undefined. Pointer carried to Task 3.
Task 2: minor (deferred): explicitTlsConnect ignores a pre-banner 421 and may emit error twice (lib/feeds/explicitTlsConnect.js:60-71).
Task 2: minor (deferred): ftpsClient.test.js leaks mkdtemp dirs; no test for rejectUnauthorized:false path.
Task 2: complete (commits 34db2de..bc74ee0, review clean)
Task 3: BASE bc74ee0, dispatched (opus).
Task 3: implemented (commits bc74ee0..308c370: 504ee4c feeds.js entry, 308c370 service + script), DONE_WITH_CONCERNS. Review dispatched.
Ruling: `seedCommand: 'seed-jrp'` is added in Task 5 together with the npm script, because `verify-cron` (run by npm test) fails when feeds.js names a script that package.json lacks; fetchCommand is registered now and ships in the same deploy - cost if wrong: none, the branch merges as one unit.
Ruling (for Task 4): IngestRun has no meta/notes column and no migration will be added (shared prod database policy); the unmatched report key is deterministic (`feeds/jrp-ftp/reports/<runId>/...`), so the run id locates it; the apply logs the key and sets `artifactBatchId` + `sourceHash` like Keystone - cost if wrong: the panel cannot link to the report without a later small schema change.
Ruling (for Task 4): VendorProduct has no MAP column; MAP is parsed, validated and counted (map-below-cost) but never written - cost if wrong: none, matches the brief.
Task 3: review clean. Controller checked ⚠️: real JUSJEE.csv header passed verifyLocalFile in the implementer's one-off check (quoted header, no BOM seen in discovery); createFtpsClient option shape matches the Task 2 report API.
Task 3: minor (deferred): `{...DEFAULT_LIMITS, ...limits}` lets undefined disable a gate (services/feeds/jrpFetchService.js:328).
Task 3: minor (deferred): DEFAULT_CACHE_DIR read at module load (jrpFetchService.js:182); Keystone reads per call.
Task 3: minor (deferred): warmCache failure after registration marks the run failed (jrpFetchService.js:303-307), same gap as Keystone.
Task 3: minor (deferred): port upper bound unchecked; script comment forward-references Task 5; test temp dirs leak; weak scratch-dir assertion (test:500).
Task 3: complete (commits bc74ee0..308c370, review clean)
Task 4: BASE 308c370, dispatched (opus).
Task 4: implemented (commits 308c370..4847582, 7 commits), DONE_WITH_CONCERNS. Pre-review fix round 1 dispatched (resume implementer): reports under feeds/jrp-ftp/reports/ would be pruned by retention after 24h.
Ruling: JRP per-run reports live at `reports/jrp-ftp/<runId>/` outside the `feeds/` prefix, which retention never touches - cost if wrong: reports accumulate in Spaces (small JSON/CSV per run) until someone prunes them by hand.
Ruling: MAP -0.01 rows kept with map null and counted as map-below-cost; `--force` (skip hash gate only) accepted; 25-row fixture accepted; failed report upload marks the run failed (rerun is safe).
Task 4: fix round 1/5 (1 addressed, 0 open; commit 7656df8 reports under reports/jrp-ftp/). Review dispatched.
Task 7: front-end branch feat/jrp-export-columns from master cb57e75, BASE cb57e75, dispatched (opus) in parallel with Task 4 review (separate repo, no file overlap).
Task 7: implemented (front c3a2eb6), DONE_WITH_CONCERNS: helper jrpExportFields.js instead of inline find. Review dispatched.
Task 4: review clean. Controller checked ⚠️: real SQL will be exercised in the sandbox dry run before any production apply; FeedArtifact.sha256 is what the fetch registers (Task 3 payload); the bucket is a plain Spaces bucket, any prefix works; discovery saw no BOM in JUSJEE.csv.
Task 4: minor (deferred): duplicate JRPSKU tie-break not fully deterministic (lib/feeds/jrp/jrpWrite.js:401-402); real file has no duplicates.
Task 4: minor (deferred): two JRPSKUs can map to one product without a count (ambiguous/Airaid strip).
Task 4: minor (deferred): materialized.stale flag ignored (jrpIngest.js:101-110).
Task 4: minor (deferred): lock.release throw skips stage.close and fails a successful run (jrpIngest.js:290-293).
Task 4: minor (deferred): failures= hard-coded 0 in logDone; no BOM tolerance (fails closed); fixture holds 25 real cost rows (repo already tracks Keystone Inventory.csv with costs); small test gaps (dry run + hash gate, dry run + force, duplicate JRPSKU through DISTINCT ON).
Task 4: complete (commits 308c370..7656df8, review clean after fix round 1)
Task 5: BASE 7656df8, dispatched (opus).
Task 7: review clean. Controller checked ⚠️: not pushed (verified below); vendor name 'JRP' is what seed-jrp creates (Task 4 VENDOR_NAME).
Task 7: minor (deferred): spread pattern differs from inline find of other vendors (Items.jsx); helper assumes vp.vendor exists (same as neighbours); no integration test of the spread sites.
Task 7: complete (front commits cb57e75..c3a2eb6, review clean)
Task 5: implemented (commits 7656df8..5c8a0a3: f3087f2 wiring, 5c8a0a3 env names), DONE_WITH_CONCERNS. Pre-review fix round 1 dispatched: seed-jrp out of seed-all.
Ruling: seed-jrp stays out of seed-all (commented like seed-tdot) until the first manual production run is verified; daily apply comes from the feed-apply-jrp cron (default off) - cost if wrong: one line to add later.
Ruling: applyCommand on the jrp-ftp entry accepted; `.kamal/secrets` lines are local-only by design (file is gitignored); kamal pre-build hook will require JRP_FTP_HOST/USER/PASS in .env.production from the next deploy (already present there, the probe used them).
Task 5: fix round 1/5 (1 addressed, 0 open; commit 0fdc506). Review dispatched.
Task 6: BASE 0fdc506, dispatched (opus) in parallel with Task 5 review (docs only, commits only docs/ paths).
Task 5: review clean. Controller checked ⚠️: JRP_FTP_HOST/USER/PASS/PORT are present in .env.production (checked with [ -n ], values never printed), so the kamal pre-build hook passes; .kamal/secrets lines are local by design.
Task 5: minor (deferred): feeds.js comment hardcodes "9:50"; cronJobs.test.js override case only covers the fetch schedule; deploy.yml JRP_FTP_MAX_ATTEMPTS repeats the default without a comment; .env.example grouping.
Task 5: complete (commits 7656df8..0fdc506, review clean after fix round 1)
Live verification (controller, sandbox Postgres 127.0.0.1:5456, 2,506 prod Product rows copied read-only for the 10 prefixes):
- feed-fetch-jrp against the real FTPS: AIA fetch of RapidSSL intermediate, download ok, batch catalogued in the sandbox, object feeds/jrp-ftp/2026/10/20261027T150636Z-a5ff29ec-JUSJEE.csv in the real bucket (no prod catalog row, retention prunes it after 24h).
- seed-jrp --dry-run: parsed 26451, invalid 0, matched 2224 (= discovery estimate), ambiguous 89, unmatched 24227, map-below-cost 31; nothing written (0 vendors, 0 vendorProducts, no run).
- seed-jrp: vendor JRP created, 2224 inserted, run 2 success; rerun: skipped-unchanged in 1 ms; --force: 0 inserted 0 updated (idempotent); 35 rows with "4+"; no product with two JRP rows.
- Observed minors for the final review: fetch logs "Could not read certs/jrp-ftp-ca.pem from the bucket: UnknownError" and "TLS validation is going to fail" although AIA then recovers (misleading); the 25-row unmatched sample is the first 25 rows (all AlphaRex), a per-brand breakdown would be more useful; sandbox runs uploaded reports to the real bucket at reports/jrp-ftp/2/ and /4/ (orphans, harmless).
Ruling: the sandbox fetch/apply used the real FTP and the real Spaces bucket (one 2.9MB feed object plus two tiny report folders) - cost if wrong: a few orphan objects; the feed object is pruned by retention, the reports stay until deleted by hand.
Task 6: implemented (commit d6c5d06), DONE_WITH_CONCERNS. Review dispatched.
Task 6: review clean. Controller checked ⚠️: fetch messages, pre-build hook, deploy.yml values, CSV columns and seed-all comment were verified by the Task 3/4/5 reviewers and the live sandbox run.
Task 6: minor (deferred): new-brand activation step should say a real apply of the same file is skipped-unchanged until --force or the next file (JRP_FEED.md:333); dd-020 could cite the measured sandbox numbers instead of "about 2,200"; missing the DRY RUN "source identical" log line in the runbook (jrpIngest.js:181); mixed brand names/prefixes in dd-020:464-466; FEEDS.md rollout status mentions only Keystone.
Task 6: complete (commits 0fdc506..d6c5d06, review clean)
All tasks complete. Final whole-branch review dispatched (opus): back e336c75..d6c5d06, front cb57e75..c3a2eb6.
Final review: With fixes. Important #1 digest shows jrp-ftp failing until the first prod fetch (docs), #2 no "turning it off" section and manual DELETE cascades into OrderProduct (docs). Minors #3 misleading CA warnings, #4 useless unmatched sample, #5 ambiguous never listed, #6 no catch-up fetch, #7 rowsMarkedStale label, #8 skipped-locked exits 0. All per-task deferred minors triaged "can wait".
Ruling: ONE fix wave covers #1, #2, the T6 one-liner, #3, #4, #5 (they make the first production run readable); #6 is deferred until a week of logged publish times exists (noted in the runbook); #7 and #8 parked - cost if wrong: panel shows "stale" rows as if acted on and a lost-lock Run now looks green; both documented.
Ruling on declined-to-judge lines: stale rows keep last stock/cost (team policy, never auto-zero); min-matched gate; ambiguous written with tie-break; reports never pruned; orphan sandbox objects; runLock semantics; no dry run from the panel - all stand as decided.
Fix wave BASE d6c5d06, dispatched (opus).
Fix wave: implemented (d6c5d06..8ba7ef1: 9a83213, 4518630, a985fd8, 8ba7ef1). Scoped re-review dispatched.
Live re-check after the fix wave (sandbox): fetch logs "ℹ️ No pinned CA at certs/jrp-ftp-ca.pem in the bucket" (no UnknownError), a transient PASV data-connection timeout on attempt 1 was retried and the file was identical => nothing uploaded; forced apply 0/0 with report at reports/jrp-ftp/6/ (json 2.3MB incl. ambiguous list).
Scoped re-review: clean, all six items resolved, no new breakage. Final suites: back `npm test` 817 tests / 812 pass / 5 pre-existing skips; front `npm run lint` clean, `npm test` 179/179. Sandbox container removed. Branch HEAD 8ba7ef1 (24 commits). Nothing merged, pushed or deployed.

## Adversarial test (2026-10-27, after the final review)
Method: one independent Opus agent ran nine probe scripts against the real modules (CSV shape, values, matching, gates, orchestration through the fake world, fetch gates, injection) and the controller profiled the real file of the day (26,451 rows). No critical finding, no unwanted write.
Medium (fixed the same day): feed collisions, two JRPSKUs whose OEMSKU canonicalize to the same part (six real Holley pairs, 12-125 vs 121-25) both matched one product and both were written (925c7f5); duplicate JRPSKU rows picked an arbitrary winner in DISTINCT ON and were not reported (f4e3c69); a BOM or spaces in the header passed the fetch signature check but csv-parser kept them, so every row failed at apply (1fdc337, shared streamCsv change, Keystone behaviour otherwise unchanged); a JUSJEE.csv uploaded through the panel or the CLI skipped the quote parity check, a stray inch mark dropped rows silently (2648ec8).
Low (left open, listed in dd-020 section 10): cost 0 accepted; Airaid strip case sensitive; cleanup errors after a successful apply exit 1; JRP_MIN_MATCHED accepts 0x10 and 1e3; JRP_ACTIVE_BRANDS typo gives no warning; resolveSource with a missing file or hash gives an unclear error.
Fails safe but brittle (documented, not changed): multi-line quoted DESCRIPTION fails the parity gate; IN-STOCK outside 0..3 and 4+ or an empty MAP is invalid; trailing blank lines count as invalid rows.
Ruling: fix the four medium findings before the merge, leave the low ones - the mediums can write a wrong cost or block the feed silently, the lows fail loudly or need a feed format JRP does not use - cost if wrong: four small commits to revert.
Docs commit 7386376 (runbook and dd-020: new gate, duplicate and collision lists).

## Review of the fixes (Opus, 2026-10-27)
Findings: M1 a collision loser already in VendorProduct was listed as stale missing-from-feed and stayed frozen; M2 the smallest-JRPSKU fallback could apply the cost of the wrong part when no row was exact; L1 the readFeed comment overstated what the header trim handles; L2 dedupe keeps the first copy even if only a later one matches; L3 matchRows picked the winner by JRPSKU, not by entry. Verified clean: streamCsv error propagation, backpressure and empty files for every feed, counts adding up, DISTINCT ON reduced to a safety net, determinism of the collision rule.
Ruling: M2 fixed by writing nothing for a product with no exact row (or more than one), reported as feed-collision:unresolved, and by counting "sku minus prefix" as exact (441c62c); M1 fixed by giving stale rows a reason, feed-collision for collision losers (4d661ab); L1 and L3 folded into those commits plus the two missing tests (7eb5e31); L2 accepted as is - a repeated JRPSKU with different OEMSKUs is already a broken feed - cost if wrong: one product's cost missing until the catalog part number is corrected.
Final state: HEAD 7eb5e31, 32 commits, `npm test` 833 tests / 828 pass / 0 fail / 5 pre-existing skips, verify-cron 18 crons ok. Real file of 2026-10-27 through the new path: 26,451 parsed, 0 invalid, 0 duplicates, parity ok, 59 ms. Nothing merged, pushed or deployed.
