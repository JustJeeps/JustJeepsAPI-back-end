# TDOT competitor prices: runbook

Design and decisions: [dd-019-tdot-in-house-scraper.md](./design/dd-019-tdot-in-house-scraper.md).

## What runs

`npm run seed-tdot` collects TDOT prices through the Klevu search API behind
tdotperformance.ca (the storefront's own search; the HTML search pages are disallowed by
the site's robots.txt), matches them to our products by `Product.tdot_code`, and writes
`CompetitorProduct` rows for `competitor_id = 4` with the same upsert as before.

| Piece | File |
|---|---|
| Config (env with clamps) | `config/tdot.js` |
| Collector (pure, tested) | `lib/competitors/tdot/*` |
| Acquisition facade (legacy contract) | `prisma/seeds/api-calls/tdot-api.js` |
| Runner + upsert | `prisma/seeds/seed-individual/seed-tdot.js` |
| Cron (opt-in) | `config/cron-jobs.js`, `CRON_SEED_TDOT_ENABLED` / `CRON_SEED_TDOT_SCHEDULE` (default `43 1 * * *`) |
| Snapshots | `prisma/seeds/logs/tdot/tdot-run-<runId>[-dry-run]-<timestamp>.json`, one per run; real runs also refresh `latest-snapshot.json` and upload their file to Spaces (`npm run log-archive -- list --command seed-tdot`) |
| Log | `prisma/seeds/logs/seed-tdot.log` (cron); `npm run log-archive -- list --command seed-tdot` |
| Run record | `IngestRun` rows with `feed = 'tdot'` |

## How to run

```bash
npm run seed-tdot -- --dry-run                 # collect, match, print the summary, write nothing
npm run seed-tdot                              # collect + write
npm run seed-tdot -- --from-snapshot prisma/seeds/logs/tdot/latest-snapshot.json   # ingest a saved snapshot
TDOT_LABEL_LIMIT=3 npm run seed-tdot -- --dry-run   # quick check on three labels
```

In production, through kamal: `kamal app exec 'npm run seed-tdot -- --dry-run'`.
`SCRAPER_CONTACT_EMAIL` must be set (it goes in the User-Agent). A full run makes about
3,000 requests and takes about 45 minutes (measured 2026-10-02, concurrency 2, 1 s delay).

Exit codes: `0` success, `1` failed (nothing written), `2` partial (rows written, but the
crawl stopped on its request or time budget; the cron e-mail fires, rerun or raise the budget).

Before the first real run, check that competitor 4 has no duplicate keys (the upsert keys on
`competitor_sku`; the old seed never guaranteed uniqueness):

```sql
SELECT competitor_sku, count(*) FROM "CompetitorProduct" WHERE competitor_id = 4 GROUP BY 1 HAVING count(*) > 1;
```

## Reading the summary

The last log line is `[tdot] SUMMARY {...}`:

| Field | Meaning |
|---|---|
| `sourceRows` / `validRows` | rows the collector produced / rows with a code and a numeric price |
| `missingProducts` | rows whose `tdot_code` matched no product (should be 0: codes come from our own products) |
| `wouldWrite` | rows sent to the upsert (dry run: what would be written) |
| `inserted` / `updated` / `skipped` | new rows / rows whose price, link or product changed / rows already up to date (not rewritten) |
| `requests` / `failedRequests` | Klevu calls made / calls that failed after retries |
| `matched` / `unmatched` | TDOT items that are ours / TDOT items we do not sell |
| `invalid` | records without a usable price or part number |
| `partial` | the request or time budget stopped the crawl early |

The collector line `[tdot] step=collect ...` carries the same numbers plus duplicates and
ambiguous codes; `labelStats` in the snapshot lists, per label, the mode (`crawl`,
`per-product`, `skip`, `not-on-tdot`, `over-budget`, `probe-failed`), the term used, the
requests, the matches and `unmatchedSample` (five TDOT titles we do not sell). `not-on-tdot`
means the brand probe returned no record of that brand: TDOT does not carry it, no requests
are spent on it.

## When it fails

- Exit code 1 and `[tdot] run N FAILED: ...`. The canaries (`REQUEST_FAILED_RATIO`,
  `BELOW_MIN_MATCHED`, `PRICE_INVALID_RATIO`) abort before any write; the IngestRun row keeps
  the code and the message.
- `TDOT_MATCH_DROP`: the run matched fewer than `TDOT_MATCH_DROP_RATIO` (default 0.8) of the
  rows the last successful run wrote (`IngestRun.sourceRowCount`). Nothing is written; look at
  `labelStats` for labels that went `probe-failed` or `not-on-tdot` unexpectedly.
- `TDOT_NO_ROWS`: the source produced no matched row (empty snapshot, ParseHub down).
- `TDOT_SOURCE_UNAVAILABLE`: `TDOT_CONSECUTIVE_FAILURE_LIMIT` (default 10) requests failed in a
  row; the circuit breaker stops the run instead of burning the whole budget.
- `TDOT_SNAPSHOT_INVALID`: `--from-snapshot` was given a file that is not a TDOT payload
  (schema version, source or items). A valid snapshot still goes through the same canaries as
  a live run, so `--from-snapshot` is not a way around them.
- `TDOT_CONFIG_NOT_FOUND`: the storefront no longer exposes the Klevu key or Klevu's config
  JSON changed. Set `TDOT_KLEVU_API_KEY` and `TDOT_KLEVU_SEARCH_DOMAIN` from a browser network
  trace of a search on tdotperformance.ca as a stop-gap, then fix `discoverConfig.js`.
- Per-request failures are listed under `failures` in the snapshot with label, term, code
  and HTTP status; the run continues past them.
- Cutover escape hatch: `TDOT_SOURCE=parsehub` with `PARSEHUB_API_KEY` reads ParseHub's last
  run instead of Klevu (parsing unchanged from the old implementation).

## Investigating unmatched products

- Products of ours never seen: compare `labelStats` (per label: `total`, `matched`) with the
  count of our products per label (`SELECT split_part(tdot_code,' ',1), count(*) FROM "Product" WHERE tdot_code <> '' GROUP BY 1`).
  A label with `total > 0` and `matched = 0` usually means TDOT writes the brand differently
  (compare `unmatchedSample` titles with our `tdot_code`); fix the `tdot_code` label in
  `prisma/seeds/hard-code_data/vendors_prefix.js` and re-seed products.
- `ambiguous` in the snapshot lists `tdot_code` values shared by two of our products (six
  labels are used by two jj prefixes, and about 550 are trailing-hyphen duplicates in our
  catalog). The seed writes one row per `tdot_code` and picks the owner deterministically:
  the active product (`status = 1`) first, then the lower sku.
- `invalidSample` shows records rejected with a reason (`invalid-price`, `currency-mismatch`,
  `no-part-number`).

## Not done yet (see DD-019 phases 3 to 5)

Parity numbers against the last ParseHub data, enabling the cron, retiring the ParseHub path
and rotating its key, the gated stale delete after 30 days of `updated_at` data.
