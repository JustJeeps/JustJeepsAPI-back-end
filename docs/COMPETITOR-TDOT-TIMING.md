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
| Write time | above 1 min | the first real run wrote 35,799 rows in 18 batches in 4 s; ten times slower means the shared database is the bottleneck |
| One label | above 15 min | a single label is eating the night; check its mode (`crawl` vs `per-product`) |
| Status | any `partial` | the budget was hit and some labels were not fetched |
| Night to night | total time up 25% with the same request count | Klevu is getting slower or throttling us |

## Runs

| Date | Run | Kind | Status | Total | Collect | Write | Requests | Matched | Written (ins / upd / same) | Slowest labels | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-02 | 1170 | full dry run (no write) | success | 46.1 min | 46.1 min | none | 3,058 | 35,870 | none | not recorded (timing per label added 2026-10-05) | Baseline. 1.8 s per request per worker; uses 31% of the time budget and 51% of the request budget |
| 2026-10-06 | 1235 | first real run (cron 01:43) | success | 27.7 min | 27.5 min (probe 3.5 min, fetch 23.9 min, match 5 s) | 4 s | 1,993 (0 failed) | 35,799 | 4,534 / 31,265 / 0 | Power Stop (per-product, 180 req) 4.4 min, WeatherTech (per-product, 120 req) 2.9 min, Crown Automotive (crawl, 90 req) 2.4 min, Rough Country (crawl, 76 req) 2.2 min, Magnaflow (crawl, 61 req) 1.7 min | No tuning needed. Every limit is clear: 18% of the time budget, 33% of the request budget. 0 unchanged because every ParseHub row got a new URL or price. See note 1 |

## Notes

1. **Run 1235 left 3,694 of the 39,493 TDOT rows untouched.** They keep the old ParseHub price
   (last refreshed in March 2026). The largest groups by first word of `competitor_sku`: Omix-ADA
   1,873, Rugged Ridge 475, UnderCover 305, Curt 134, Alloy USA 103, Rough Country 99, Corbeau 91,
   Fuel 54. Seven labels came back `not-on-tdot` from the probe (Alloy USA, Corbeau Seats, Fuel,
   MOPAR PERFORMANCE, Pro Comp Suspensions, Rubicon Express, Smittybilt). Corbeau and Fuel are big
   on TDOT, so the probe term from our label name ("Corbeau Seats") may be the problem, not the
   store. This is a coverage issue, not a timing one: until the stale delete exists, those rows
   show old prices.
2. The 2026-10-02 dry run made 3,058 requests against 1,993 on 2026-10-06 because the
   `not-on-tdot` gate was added after it: those labels no longer cost per-product queries.
