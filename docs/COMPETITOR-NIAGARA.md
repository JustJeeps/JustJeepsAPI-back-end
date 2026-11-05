# Niagara Jeeps competitor prices: runbook

Design and decisions: [dd-021-niagara-competitor-scraper.md](./design/dd-021-niagara-competitor-scraper.md).

## What runs

`npm run seed-niagara` reads the public Shopify collection JSON of niagarajeeps.ca for every
brand mapped in `vendors_prefix.js` (`niagara_code`), matches each variant SKU to our product of
that brand, and writes `CompetitorProduct` rows for the competitor named `Niagara Jeeps` (price
and product link). It never deletes anything.

| Piece | Where |
|---|---|
| Config | `config/niagara.js` (`NIAGARA_*` env) |
| Runner | `prisma/seeds/seed-individual/seed-niagara.js` |
| Cron (opt-in) | `CRON_SEED_NIAGARA_ENABLED`, `CRON_SEED_NIAGARA_SCHEDULE` (default `13 4 * * *`) |
| Snapshots | `prisma/seeds/logs/niagara/niagara-run-<id>[-dry-run][-sample]-<stamp>.json`; full successful runs also refresh `latest-snapshot.json` |
| Review CSV | `prisma/seeds/logs/niagara/niagara-run-<id>-report-<stamp>.csv` (unmatched, collision, ambiguous); real runs upload snapshot and CSV with the log archive |
| Run record | `IngestRun` rows with `feed = 'niagara'` |

## How to run

```bash
npm run seed-niagara -- --collect-only --brands=BIL,RC --max-pages=1   # read the site only, no database
npm run seed-niagara -- --dry-run                                     # collect + match + summary, write nothing
npm run seed-niagara                                                  # collect + write
npm run seed-niagara -- --from-snapshot prisma/seeds/logs/niagara/latest-snapshot.json
```

In production: `set -a; source .env.production; set +a; kamal app exec --reuse "npm run seed-niagara -- --dry-run"`.
`SCRAPER_CONTACT_EMAIL` is required for any run that reads the site (it goes in the User-Agent).

## Reading the summary

The last line is `[niagara] SUMMARY {...}`: `items` collected, `matched`, `inserted`, `updated`
(price or link changed), `unchanged`, `skipped` (unmatched, collisions, invalid), `markedStale`
(rows of Niagara Jeeps not seen this run, kept), and `collection` (requests, retries,
rateLimited, brands ok, failed, empty, impure). Each brand also logs one line with its status:
`ok`, `short` (fewer products than the collection says), `empty`, `impure` (over 25% of another
vendor, counted as failed), `failed`, `missing-handle`, `page-cap` (the last allowed page was full,
so the brand may have more), `over-budget`.

## When it fails

| Code | Meaning | What to do |
|---|---|---|
| `NIAGARA_CHALLENGED` | the site answered with the Cloudflare challenge | nothing was written; try again later; if it repeats from the server, collect from a laptop with `--collect-only` and ingest with `--from-snapshot` |
| `NIAGARA_SOURCE_UNAVAILABLE` | 5 requests in a row failed | site down or blocking; nothing was written |
| `NIAGARA_CANARY_FAILED` | too many failed requests or brands, broken prices, or too few items | read the message; nothing was written |
| `NIAGARA_MATCH_GUARD` | matched under the floor or under 0.8 of the last full run | check the brand lines (a renamed collection shows `missing-handle`); nothing was written |
| exit 2, status `partial` | the request or time budget ran out | rows written for the brands collected; raise `NIAGARA_MAX_REQUESTS` or `NIAGARA_MAX_RUN_MINUTES` if it repeats |

## Adding or fixing a brand

1. Run `node scripts/niagara-brand-discovery.js` (read-only) and open the CSV under `prisma/seeds/logs/niagara/`.
2. Add `niagara_code: "<collection handle>"` to the brand's row in `vendors_prefix.js`, and
   `niagara_sku_prefixes: ["XYZ-"]` if Niagara puts a code before the part number.
3. `npm test` (a test checks the mapping file), then a sample run:
   `npm run seed-niagara -- --dry-run --brands=<jj_prefix> --max-pages=1`.

## Turning it off

Set `CRON_SEED_NIAGARA_ENABLED: "false"` in `config/deploy.yml` and redeploy. Existing rows stay.
