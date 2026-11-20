# MyTruckPoint competitor prices: runbook

Design and decisions: [dd-022-mytruckpoint-competitor-scraper.md](./design/dd-022-mytruckpoint-competitor-scraper.md).
It runs on the shared Shopify competitor code, the same as Niagara Jeeps ([COMPETITOR-NIAGARA.md](./COMPETITOR-NIAGARA.md)).

## What runs

`npm run seed-mytruckpoint` reads the public Shopify collection JSON of mytruckpoint.ca for every
brand mapped in `vendors_prefix.js` (`mytruckpoint_code`), keeps the listings whose SKU starts with
one of the brand's `mytruckpoint_sku_prefixes`, matches them to our products of that brand, and
writes `CompetitorProduct` rows for the competitor named `MyTruckPoint` (price and product link).
It never deletes anything.

| Piece | Where |
|---|---|
| Config | `config/mytruckpoint.js` (`MYTRUCKPOINT_*` env) |
| Store profile | `lib/competitors/mytruckpoint/profile.js` |
| Runner | `prisma/seeds/seed-individual/seed-mytruckpoint.js` |
| Cron (opt-in) | `CRON_SEED_MYTRUCKPOINT_ENABLED`, `CRON_SEED_MYTRUCKPOINT_SCHEDULE` (default `17 22 * * 1-6`) |
| Snapshots | `prisma/seeds/logs/mytruckpoint/mytruckpoint-run-<id>[-dry-run][-sample]-<stamp>.json.gz`; full successful runs also refresh `latest-snapshot.json.gz` |
| Review CSV | `prisma/seeds/logs/mytruckpoint/mytruckpoint-run-<id>-report-<stamp>.csv` (unmatched, collision, ambiguous); real runs upload snapshot and CSV with the log archive |
| Run record | `IngestRun` rows with `feed = 'mytruckpoint'` |

A full run is about 650 requests (22 index pages plus about 630 brand pages), around 40 minutes.

## How to run

```bash
npm run seed-mytruckpoint -- --collect-only --brands=BIL,WAR --max-pages=1   # read the site only, no database
npm run seed-mytruckpoint -- --dry-run                                       # collect + match + summary, write nothing
npm run seed-mytruckpoint                                                    # collect + write
npm run seed-mytruckpoint -- --from-snapshot prisma/seeds/logs/mytruckpoint/latest-snapshot.json.gz
```

In production: `set -a; source .env.production; set +a; kamal app exec --reuse "npm run seed-mytruckpoint -- --dry-run"`.
Avoid 19:32 to 20:15 (seed-all) and 01:43 to 08:05 (competitor and Magento jobs): command crons
run one at a time and this run holds the queue for about 40 minutes.

A snapshot is replayed only if it is at most 72 hours old (`MYTRUCKPOINT_SNAPSHOT_MAX_AGE_HOURS`),
has no price over the cap, no duplicate and still passes the collection guards. Only one run at a
time: a second one exits with `MYTRUCKPOINT_BUSY`. `SCRAPER_CONTACT_EMAIL` is required for any run
that reads the site (it goes in the User-Agent).

## Reading the summary

The last line is `[mytruckpoint] SUMMARY {...}`: `items` collected, `matched`, `inserted`, `updated`
(price or link changed), `unchanged`, `skipped`, `markedStale` (rows of MyTruckPoint not seen this
run, kept), and `collection` (requests, retries, rateLimited, brands ok, failed, empty, impure,
`uncodedCount`).

Each brand logs one line: `[mytruckpoint] brand WAR (warn): ok pages=12 products=2760 items=2758 foreign=1 uncoded=0`.

- `foreign`: listings with another brand's code, dropped.
- `uncoded`: listings with no code at all, dropped. The snapshot's `brandStats[].uncodedSample`
  shows five of them. If they share a text in front of the part number (`MIS` for Mishimoto), add
  that text to the brand's `mytruckpoint_sku_prefixes`.
- Status: `ok`, `short` (fewer products than the collection says), `empty`, `impure` (foreign codes
  over 25%, or nothing of the brand's own: counted as failed), `failed`, `missing-handle`,
  `page-cap` (25,000 listings read, the brand may have more), `over-budget`.

## When it fails

| Code | Meaning | What to do |
|---|---|---|
| `MYTRUCKPOINT_CHALLENGED` | the site answered with a Cloudflare challenge | nothing was written; try later. We never disguise the client: if it repeats from the server, stop and tell Ricardo |
| `MYTRUCKPOINT_SOURCE_UNAVAILABLE` | 5 requests in a row failed | site down or blocking; nothing was written |
| `MYTRUCKPOINT_CANARY_FAILED` | too many failed requests or brands, broken prices, or too few items | read the message; nothing was written |
| `MYTRUCKPOINT_MATCH_GUARD` | a full run matched under the floor or under 0.8 of the last full run | check the brand lines and the run's report CSV; nothing was written |
| `MYTRUCKPOINT_BUSY` | another MyTruckPoint run holds the lock | nothing was done; wait for the other run |
| `MYTRUCKPOINT_BAD_SNAPSHOT` | the `--from-snapshot` file is old, broken, from another store or fails the guards | collect a fresh one |
| `MYTRUCKPOINT_WRITE_FAILED` | the database write stopped mid-way | the run records the rows already written; rerun, it continues from what is there |
| `MYTRUCKPOINT_RUN_NOT_RECORDED` | rows were written but the run outcome was not saved | exit 1; check the IngestRun row by hand |
| exit 2, status `partial` | the request or time budget ran out | rows written for the brands collected; raise `MYTRUCKPOINT_MAX_REQUESTS` or `MYTRUCKPOINT_MAX_RUN_MINUTES` if it repeats |

## Adding or fixing a brand

1. `SCRAPER_CONTACT_EMAIL=... node scripts/mytruckpoint-brand-discovery.js` (read-only, cached). It
   writes `discovery.json`, `proposal.txt` and `team-review.csv` under
   `prisma/seeds/logs/mytruckpoint/discovery/`.
2. Add `mytruckpoint_code: "<collection handle>"` and `mytruckpoint_sku_prefixes: ["XXXX_"]` to the
   brand's row in `vendors_prefix.js`. The file is kept by a colleague: add lines only, change
   nothing else, and show the diff.
3. `npm test` (a test checks the mapping: handle, a 4-letter code, no code on two brands), then a
   sample run: `npm run seed-mytruckpoint -- --dry-run --brands=<jj_prefix> --max-pages=1`.

## Turning it off

Set `CRON_SEED_MYTRUCKPOINT_ENABLED: "false"` in `config/deploy.yml` and redeploy. Existing rows stay.
