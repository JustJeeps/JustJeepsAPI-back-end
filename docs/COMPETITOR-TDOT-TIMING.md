# TDOT run timing log

Audit log of how long the nightly TDOT competitor price run takes, and the rules we use to
decide whether it needs tuning. Add one row per audited run. Runbook: `docs/COMPETITOR-TDOT.md`.

## Where the numbers come from

Every run since 2026-10-05 records its timing in four places:

| Where | What |
|---|---|
| `IngestRun` (feed `tdot`) | `startedAt` and `finishedAt`: total wall time of the run |
| Run log, line `[tdot] TIMING` | total, collect and write time, the crawl phases (probe, fetch, match) and the five slowest labels with their mode and request count |
| Run log, line `[tdot] SUMMARY` | the same numbers as JSON under `timing` (`collectMs`, `writeMs`, `totalMs`) |
| Snapshot JSON | `collection.timing` (`discoverMs`, `probeMs`, `fetchMs`, `matchMs`) and `labelStats[].durationMs` for every label |

The run log and the snapshot are archived to DO Spaces after each real run:
`npm run log-archive -- list --command seed-tdot`.

Label times are wall time per label. The fetch runs two labels at a time, so the label times add
up to about twice the fetch phase.

## Current settings

| Setting | Value | Source |
|---|---|---|
| Schedule | 01:43 Toronto, every night | `CRON_SEED_TDOT_SCHEDULE` |
| Workers | 2 | `config/tdot.js` `concurrency` |
| Pause between requests | 1 s plus up to 0.3 s random, per worker | `requestDelayMs` |
| Request budget | 6,000 | `maxRequests` |
| Time budget | 150 min (the crawl stops and the run is `partial`) | `maxRunMinutes` |
| Write batch | 2,000 rows per transaction | `UPSERT_BATCH_SIZE` in `seed-tdot.js` |

## When to tune

Look at the `TIMING` line. Open an improvement task when any of these happens:

| Signal | Limit | Why |
|---|---|---|
| Total time | above 90 min | 60% of the 150 min budget; growth after that ends in a `partial` night |
| Requests | above 4,500 | 75% of the request budget |
| Write time | above 5 min | about 36k rows in 18 batches of 2,000; slower than that means the shared database is the bottleneck (adjust this limit after the first real run) |
| One label | above 15 min | a single label is eating the night; check its mode (`crawl` vs `per-product`) |
| Status | any `partial` | the budget was hit and some labels were not fetched |
| Night to night | total time up 25% with the same request count | Klevu is getting slower or throttling us |

## Runs

| Date | Run | Kind | Status | Total | Collect | Write | Requests | Matched | Written (ins / upd / same) | Slowest labels | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-02 | 1170 | full dry run (no write) | success | 46.1 min | 46.1 min | none | 3,058 | 35,870 | none | not recorded (timing per label added 2026-10-05) | Baseline. 1.8 s per request per worker; uses 31% of the time budget and 51% of the request budget |
| 2026-10-06 | | first real run | | | | | | | | | |
