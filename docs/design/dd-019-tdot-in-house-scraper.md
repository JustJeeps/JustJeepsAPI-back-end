# DD-019: TDOT In-House Scraper (replacing ParseHub)

## Document Information

| Attribute | Value |
|-----------|-------|
| Version | 0.1.0 |
| Status | Phases 1-2 built, phase 3 parity measured, phase 4 prepared (cron off); cutover pending |
| Created | 2026-10-02 |
| Last Updated | 2026-10-02 |
| Author | Ricardo Tassio, with Claude Code (round table: back-end, data, architecture seats) |
| Parent PRD | [competitor-price-tracking-prd.md](../prd/competitor-price-tracking-prd.md) |
| Sibling | [dd-018-lowriders-competitor-scraper.md](./dd-018-lowriders-competitor-scraper.md) (reference architecture) |

## Context

The stakeholder spec asks to replace ParseHub for TDOT competitor prices with an in-house
scraper, keep `seed-tdot.js` persistence as is, extract only brand, SKU and price, isolate
failures, print a run summary, add tests and a runbook. This document records what the team
found about the current state, the three perspectives, and the recommended path.
Repo: `JustJeepsAPI-back-end`. Everything in English.

## 1. What we have today (verified in the code on 2026-10-02)

### The pipeline

| Step | Where | What it does |
|---|---|---|
| Acquisition | `prisma/seeds/api-calls/tdot-api.js` | One GET to ParseHub `projects/t84q4nt7WzTR/last_ready_run/data` with the **API key hard-coded in the URL**; returns `[{ tdot_price, tdot_code, sku, brand, product_url }]`, deduped by `tdot_code` (last wins); writes a stray CSV in the current directory |
| Persistence | `prisma/seeds/seed-individual/seed-tdot.js` | Keeps `tdot_code`, `tdot_price`, `product_url`; matches `Product.tdot_code` exactly (chunks of 1,000); raw-SQL UPDATE + INSERT WHERE NOT EXISTS into `CompetitorProduct` with `competitor_id = 4` (batches of 2,000) |
| Scheduling | `seed-all.js` (`otherSeeds`), 06:00 and 19:00 Toronto | Sequential tail; log `prisma/seeds/logs/seed-tdot.log`; no IngestRun; `CRON_TEST_COMMAND` defaults to `seed-tdot` but production overrides it |

Matching key: `Product.tdot_code = "<vendors_prefix.tdot_code> <searchable_sku>"` (e.g.
`Bestop 52401-01`), and `Product.tdot_url = https://www.tdotperformance.ca/catalogsearch/result/?q=<searchable_sku>`,
both written by `seed-allProducts.js` and `seed-vendor-prefix-fast.js`. 137 brands carry a
TDOT label. **We already know, per product, what to look for before visiting the page.**

### Defects in the current persistence (pre-existing, not caused by ParseHub)

- Errors are caught and logged; the process exits 0, so `seed-all` reports success on failure.
- `updated_at` is never written on UPDATE; every matched row is rewritten each run.
- No stale cleanup: a product gone from TDOT keeps its last price forever.
- No unique constraint on `(competitor_id, competitor_sku)`, only an index.
- Six TDOT labels are shared by two jj prefixes (Banks Power, ION, K&N/Kenda, Pro Comp Wheels,
  Bridgestone, Goodyear): two products can carry the same `tdot_code`, last one wins.
- The ParseHub key also sits (commented) in `northridge-api.js`, `partsEngine-api.js`,
  `omix-inventory-api.js` and in two design docs; DD-018 wrongly says it was removed.
- Docs are stale: dd-006 and the competitor PRD describe TDOT as an Excel import; dd-011,
  dd-002 and the multi-vendor PRD call TDOT "Tire Discounter"; the data-sync PRD says "CSV".

### The TDOT site (probed read-only, 6 requests)

- Magento 2 (Adobe Commerce Cloud) behind Fastly/Varnish. No Cloudflare, no captcha page.
- Search page `catalogsearch/result/?q=52401-01` came back server-rendered once (20 Luma
  cards: `li.item.product.product-item`, title `a.product-item-link`, price
  `span.price-wrapper[data-price-type="finalPrice"][data-price-amount]`), then four identical
  requests came back with no product list at all. `/graphql` answered 403.
- Search is Klevu (`js.klevu.com/core/v2/klevu.js`, public key in the page). Klevu's JSON
  endpoint was not identified yet: that is the first spike.
- A query for one SKU returns up to 20 different products: the right card must be chosen
  by exact SKU, never "first card".

### Building blocks already in the repo (Lowriders, Sept 2026, in production)

- Pure collector `lib/competitors/lowriders/*` (fetch, sleep, retry and logger injected,
  error codes, fail-loud canaries before any write), `lib/competitors/skuMatch.js`.
- Ingest `services/competitors/lowridersIngest.js` (batched SQL, `IS DISTINCT FROM`,
  `updated_at`, gated stale delete with a floor), thin runner with `--dry-run`, IngestRun,
  snapshot archived to Spaces, exit code, opt-in cron (`CRON_SEED_LOWRIDERS_ENABLED`).
- `lib/ingest/withRetry.js`, `lib/ingest/runLock.js`, `config/lowriders.js` (env with
  clamps, User-Agent with `SCRAPER_CONTACT_EMAIL`), `scripts/verify-cron-scripts.js`.
- Puppeteer 24 + stealth plugin installed (ad-hoc scrapers only). No cheerio or jsdom.
- Tests: node:test, fixtures under `test/lib/competitors/fixtures/`, injected fetch/http
  stubs, silent logger injected into libs.


### Corrections and additions from the round table (verified by the seats)

- The ParseHub key is **live** (not commented) in `northridge-api.js`, `partsEngine-api.js`
  and `omix-inventory-api.js` too. `PARSEHUB_KEY_NORTHRIDGE` exists in deploy env but nobody
  reads it. The literal must never be pasted in docs or chat; rotate it in phase 4.
- Production `seed-all` runs at 07:32 and 19:32 Toronto (`config/deploy.yml`), seed-tdot
  itself takes about 20 s; the ParseHub data is the slow and unstable part.
- Local `seed-tdot.log` (last runs 2026-03-30/31): ParseHub returned between 228 and 69,853
  rows across runs; the 873-row runs matched only 310 products and discarded 563 (64%).
  TDOT is absent from `config/feeds.js`, so the panel has never shown a TDOT run.
- `tdot-excel.js` strips the dash from Bestop SKUs: TDOT's displayed part number can differ
  from ours by formatting, which is why matching must use a canonical part number.
- `CompetitorProduct.updated_at` and the `(competitor_id, competitor_sku)` index already
  exist (DD-018 migration): no schema change is needed.

## 2. The three perspectives (what we can do, how to improve, benefits)

### Back-end engineer

- Options: (a) Klevu JSON search API, the storefront's own search; (b) plain HTTP + HTML of the
  Magento search page (came back empty on repeat; would need cheerio; fallback probe only);
  (c) headless browser with the stealth plugin (3-6 s and ~100 MB per page, highest
  fingerprint, hardest to test; emergency and fixture recording only). Fallback chain: if Klevu
  is unreachable for a run, abort with `TDOT_SOURCE_UNAVAILABLE` and write nothing; never
  degrade silently to (b) or (c).
- Layout mirroring Lowriders under `lib/competitors/tdot/` (`klevuClient`, `brandDictionary`,
  `parseCard`, `pickCard`, `collect`, `canaries`, `legacyAdapter`) plus `config/tdot.js`;
  `tdot-api.js` becomes a thin facade returning the legacy rows, so `seed-tdot.js` line 1 keeps
  working. Per-target result with the spec's failure codes plus `AMBIGUOUS_SKU`; one log line
  per 500 targets and five samples per code; summary object fed into IngestRun.
- Tests with JSON fixtures (exact SKU, sale price, no results, 20-card fuzzy page, shared
  label) and the two observed HTML pages kept as documentation; injected fetch recording calls.
- Effort about 3.5 days after a half-day spike.

### Data engineer

- Flip the matching direction: start from our catalog. Per product we know `tdot_code` and
  `searchable_sku`; a TDOT record is a hit when its SKU token canonicalizes
  (`skuMatch.canonicalPartNumber`, keeps dots, strips `-_ `) to ours. Emit brand, sku and
  tdot_code from OUR product, so `competitor_sku = tdot_code` is exact by construction. The
  spec's title dictionary stays for diagnostics (which brand TDOT shows when a card is
  unmatched, label drift, a future "products we do not sell" mode).
- Decision per product: 0 hits = unmatched with the top-3 titles; 1 hit = matched (brand
  mismatch flagged, not dropped: the part number is the stronger signal); 2+ hits = prefer
  brand match and exact raw token, then lowest final price, logged as ambiguous. Never
  "last wins". Duplicate `tdot_code` across products detected before the run; the Kenda
  entry labelled "K&N" is a data bug to fix at the source, the other five shared labels are
  one TDOT brand with two jj prefixes and are tolerated.
- Contract hygiene: price from the numeric field (`salePrice > 0 ? salePrice : price`, or
  `data-price-amount`), never from display text; reject non-finite, `<= 0`, `> 20000`, non-CAD;
  `product_url` = the product page link, never the search URL; one row per product.
- Quality gates before any write: abort when fetch failures > 10%, empty pages > 25% (bot
  block signature), invalid prices > 2%, or matched < max(200, 80% of the previous good run);
  warn on ambiguous > 2%, brand mismatch > 5%, duplicate tdot_code > 0. Snapshot JSON keeps
  items, unmatched (with top titles), ambiguous and failures for audit.
- Switch-off metric: a parity period comparing coverage and price deltas with ParseHub's data
  (deltas above 1% on fewer than 2% of overlapping keys, every delta explainable).
- Read-only sizing queries to run before the spike (count of products with `tdot_url`, per
  brand, duplicate `tdot_code`, competitor 4 rows and their `updated_at` range, orphans).

### Software architect

- Architecture: pure collector (no prisma, no env; fetch, sleep, retry and logger injected),
  `tdot-api.js` as adapter, `seed-tdot.js` as runner and ingest with the upsert SQL untouched;
  no separate ingest service because the spec keeps the upsert where it is (extracting it later
  is mechanical). Dependency direction: runner -> adapter -> collector; collector imports
  nothing outside its folder.
- Acquisition: Klevu by brand with paging (hundreds to low thousands of requests) rather than
  one query per SKU (tens of thousands); Puppeteer rejected for the shared 2 GB container.
- Minimal `seed-tdot.js` fixes now: `main()` with exit 1 on failure, IngestRun start/finish,
  `updated_at = CURRENT_TIMESTAMP` with `IS DISTINCT FROM`, no run-on-require, `--dry-run`,
  `--from-snapshot <file>`, summary line. Defer: stale delete, deeper SKU normalisation, the
  other three ParseHub feeds.
- Own opt-in cron (`CRON_SEED_TDOT_ENABLED`, `43 1 * * *`), removed from seed-all at cutover;
  budgets `TDOT_REQUEST_DELAY_MS`, `TDOT_MAX_REQUESTS`, `TDOT_MAX_RUN_MINUTES`; a partial run
  still upserts (no delete exists) and exits 1 only below `TDOT_MIN_ITEMS`.
- Rollout in five gated phases; externalization seam = the snapshot file (`--from-snapshot`),
  payload shape identical to Lowriders v1 with `source: 'tdot'`.
- Benefits: freshness we control, ParseHub retired for one of four feeds, failures become
  e-mails and panel rows, no competitor key in git, team ownership; reuse of retry, run
  tracking, log archive, cron gate and test conventions.
- Costs: markup or Klevu changes are ours to maintain (Lowriders needed 4 fix commits in its
  first weeks); single-IP exposure; robots.txt and terms to record in the spike.

## 3. Recommendation (decisions taken with Ricardo on 2026-10-02)

1. **Acquisition: Klevu JSON first, gated by a spike.** The spike tests both request shapes
   (brand-filtered paging, and one query per SKU) and picks the one with fewer requests that
   still returns per-record `sku`, `name`, `price`/`salePrice`, `url`. HTML parsing and headless
   browsing are not built; the spec's selectors are kept as documentation.
2. **Matching: product-driven**, with the spec's brand dictionary and SKU-token rules kept as
   diagnostics and as the fallback for records without a SKU field.
3. **`seed-tdot.js`: minimal operational fixes, upsert SQL untouched** (approved): exit code,
   IngestRun, `updated_at` only when the price changed, no run-on-require, `--dry-run`,
   `--from-snapshot`, summary line.
4. **Stale rows: no delete now.** Revisit after 30 days of `updated_at` data, then port the
   Lowriders gated floor (approved).
5. **Scheduling: own opt-in cron at 01:43**, out of seed-all at cutover (approved).
6. **Parity before cutover**, ParseHub untouched for 14 days after, then retire and rotate the
   key, fix the three sibling files to read `PARSEHUB_API_KEY` from env, correct the docs.

### Code layout

Planned before the spike. The modules as built differ in name (see section 5: `discoverConfig`,
`normalize`, `match`, `plan` instead of `brandDictionary`, `parseRecord`, `pickForProduct`) because
Klevu records carry a `sku` field, so no title dictionary was needed.

```
config/tdot.js                         env -> config with clamps; UA JustJeepsPriceMonitor/1.0 (+SCRAPER_CONTACT_EMAIL)
lib/competitors/tdot/
  klevuClient.js                       createKlevuClient({ fetch, searchUrl, apiKey, userAgent, timeoutMs }) -> { search(...) }
                                       typed errors: TDOT_KEY_REJECTED, TDOT_HTTP_<n>, TDOT_EMPTY_PAGE, TDOT_PARSE
  brandDictionary.js                   buildBrandDictionary(prefixes), matchBrand(title, dict)   (diagnostics + fallback)
  parseRecord.js                       price/sku/url extraction from a Klevu record -> { ok, value } | { ok:false, code, detail }
  match.js                             pickForProduct(records, product) using skuMatch.canonicalPartNumber; matched|ambiguous|unmatched
  collect.js                           collectTdot({ targets|labels, fetch, config, logger, sleep, withRetry, now }) -> payload v1
  canaries.js                          checkTdotRun(summary, thresholds) -> abort codes before any write
  legacyAdapter.js                     toLegacyRows(payload) -> [{ tdot_price, tdot_code, sku, brand, product_url }]
prisma/seeds/api-calls/tdot-api.js     facade: tdotCost({ dryRun }) = load targets + labels -> collect -> canaries -> snapshot -> legacy rows
prisma/seeds/seed-individual/seed-tdot.js   runner + unchanged upsert SQL + minimal fixes (see 3)
config/cron-jobs.js                    CRON_SEED_TDOT_ENABLED / CRON_SEED_TDOT_SCHEDULE ('43 1 * * *')
docs/COMPETITOR-TDOT.md                runbook
test/lib/competitors/tdot/*.test.js    fixtures under test/lib/competitors/tdot/fixtures/
```

Env (names): `TDOT_KLEVU_API_KEY` (default the public key found in the page, re-read each
run), `TDOT_KLEVU_SEARCH_URL`, `TDOT_REQUEST_DELAY_MS`, `TDOT_CONCURRENCY`, `TDOT_REQUEST_TIMEOUT_MS`,
`TDOT_MAX_REQUESTS`, `TDOT_MAX_RUN_MINUTES`, `TDOT_MIN_ITEMS`, `TDOT_MAX_PRICE`, `TDOT_URL_LIMIT`
(dev cap), `SCRAPER_CONTACT_EMAIL` (exists), `CRON_SEED_TDOT_ENABLED`, `CRON_SEED_TDOT_SCHEDULE`.
New env values go to `.env.production` and `.kamal/secrets` (hook aborts the deploy otherwise).

### Phases and exit criteria

0. **Spike (0.5 d, read-only, nothing merged):** browser network trace of one TDOT search
   (Playwright MCP) to capture the Klevu endpoint, key and payload; reproduce with plain
   `fetch`; test brand-filtered paging and per-SKU query; 20 known SKUs (including one on sale
   and one Bestop with a dash) return records whose SKU canonicalizes to ours with the price
   shown on the storefront; 50 sequential calls at 750 ms with no 403/429; record robots.txt
   and terms; estimate requests per night for all labels. Ricardo runs the read-only sizing
   SQL in production. Exit: a written request shape + numbers in `docs/COMPETITOR-TDOT.md`.
1. **Collector and tests (1.5 d):** `config/tdot.js`, `lib/competitors/tdot/*`, fixtures,
   unit tests for client, parse, match, brand dictionary, canaries, collect (one request per
   unique target, UA, retry on 429/5xx only, no retry on 404). Exit: `npm test` green, zero
   network in tests, every failure category exercised.
2. **Adapter, runner fixes, dry run (1 d):** `tdot-api.js` facade, `seed-tdot.js` minimal
   fixes, snapshot archived to Spaces, `TDOT_URL_LIMIT=50 npm run seed-tdot -- --dry-run` in
   dev and then full `--dry-run` in production via kamal. Exit: summary printed, snapshot
   archived, no write.
3. **Parity (a few nights):** compare the dry-run snapshot with ParseHub's best data and the
   current competitor-4 rows: coverage of products with `tdot_url`, price deltas explained
   (sale vs regular). Set `TDOT_MIN_ITEMS` from the measurement. Exit: numbers recorded.
4. **Cutover:** enable the cron, remove `seed-tdot` from `seed-all` `otherSeeds`, keep a
   `TDOT_SOURCE=parsehub` escape hatch reading `PARSEHUB_API_KEY` from env for 14 days. Exit:
   14 consecutive successful IngestRuns.
5. **Retire:** delete the ParseHub path, rotate the key (owner: whoever holds the ParseHub
   account), move the three sibling files to env, fix dd-006, dd-009, dd-011 ("Tire
   Discounter"), the data-sync PRD ("CSV") and the dd-018 claim; runbook final. Later
   (30 days of `updated_at`): gated stale delete.

### Verification

- Unit: `npm test` (no DB, no network) with the new fixtures.
- Dev: `TDOT_URL_LIMIT=50 npm run seed-tdot -- --dry-run` prints the summary and 10 rows.
- Production dry run through kamal, snapshot in Spaces, parity numbers in the runbook.
- After cutover: IngestRun rows for feed `tdot`, the daily digest line, `updated_at` moving
  only on price changes, exit code 1 reaching the cron e-mail on a forced failure.

### Benefits, in one list

- Prices as fresh as we decide (today: last ParseHub run in March, 310 products).
- Coverage bounded by our catalog instead of by a ParseHub template that discards 64%.
- Failures visible: exit codes, IngestRun rows, categorized counters, snapshot for audit.
- No third-party API key in git; one of four ParseHub feeds retired, the pattern ready for
  Parts Engine, Northridge and Omix inventory.
- Reuse of the Lowriders stack: same tests, same ops, same externalization seam.

## 4. Spike results (2026-10-02, read-only, about 15 requests)

### The search API behind the storefront

- The storefront page loads Klevu's store config from
  `https://js.klevu.com/klevu-js-v1/klevu-js-api/<apiKey>.json`, which names the search host:
  `klevu_userSearchDomain = uscs32.ksearchnet.com` (public key in the page HTML, re-read each
  run; `klevu_layoutType = slim`).
- Search endpoint (Klevu JS v1 cloud search), one GET, JSON answer in about 0.5 to 0.9 s:
  `https://uscs32.ksearchnet.com/cloud-search/n-search/search?ticket=<apiKey>&term=<text>&noOfResults=100&paginationStartsFrom=<n>&responseType=json&klevuShowOutOfStockProducts=true&klevuSort=rel&enableFilters=false` (the spike used `enableFilters=true`; the facets were never read, so the client sends `false` to keep the answers small)
- Record fields used: `sku` (`Bestop-52401-11`: TDOT brand token + part number), `name`
  (`Bestop 52401-11 - Sun Bikini Top ...`: the text before ` - ` is exactly our `tdot_code`
  format), `price`, `salePrice`, `oldPrice`, `startPrice`, `basePrice`, `discount`, `currency`
  (`CAD`), `url` (product page), `inStock`, `id`, `category`, `totalVariants`. Without a
  promotion the three price fields are equal and `discount` is empty, so the rule is
  `salePrice` when numeric, else `price`; `oldPrice` is kept only for the log.
- `meta.totalResultsFound`, `meta.typeOfQuery` (`FUZZY_AND` for a part number,
  `WILDCARD_AND` for a brand word), `meta.notificationCode`.

### Two request shapes measured

| Shape | Request | Result |
|---|---|---|
| Brand crawl | `term=Bestop`, `noOfResults=100`, `paginationStartsFrom=0,100,...` | 780 items, page size capped at 100 (500 asked, 100 returned), pages stable with no overlap, 100% `Bestop-` SKUs |
| Per SKU | `term=Bestop 52401-01` | Fuzzy: 31 look-alikes, the exact part absent (not sold by TDOT); `term=Rugged Ridge 11540.11` returned 11540.13, .61, .14 but not .11 |
| Whole catalog | `term=*` | 710,626 items (TDOT's full catalog; not useful) |

Decision taken: **brand crawl**. One request per 100 items per label, then match in memory
against our products by canonical `tdot_code` (name prefix before ` - `, or `sku` with the
first hyphen turned into a space). Per-SKU queries are fuzzy and would cost one request per
product; they stay only as a diagnostic tool.

### Politeness and terms

- `https://www.tdotperformance.ca/robots.txt`: `Crawl-delay: 2`, `Disallow: /catalogsearch/`,
  `Disallow: /search/`, `Disallow: /*?*manufacturer`, product pages under `/products/`
  allowed. Scraping the HTML search pages (what `tdot_url` points to, and what ParseHub did)
  is explicitly disallowed by the site; the Klevu endpoint is a different host, built for the
  storefront's own browser calls. The crawler keeps a 2 s spacing anyway and identifies
  itself (`JustJeepsPriceMonitor/1.0 (+SCRAPER_CONTACT_EMAIL)`).
- The HTML search page itself is server-rendered (Magento + Klevu "slim" layout): 20 cards
  per page, title in `div.product-item-name > a`, price in
  `span.price-wrapper[data-price-type="finalPrice"][data-price-amount]`, brand and name also
  present in the `data-gtm-event` JSON of each card. Recorded for documentation only; the
  earlier "empty page" observation came from a grep on a class the theme does not use.

### Volume (one request per label, 131 distinct labels, 2 s apart, 0 errors, 464 ms average)

- A brand word as `term` is a wildcard text search, not a brand filter: Klevu has no brand
  facet for this store. 110 of 131 labels return only their own brand; 21 pull in other
  brands or use a different SKU token than our label (`OmixADA-`, `FoxShox-`,
  `ProCompRims-`, `Auto_Ventshade-`, `TRex-`; "Fuel", "Corbeau Seats", "MOPAR PERFORMANCE",
  "Smittybilt" return mostly unrelated items). Noise does not break matching (we match by the
  canonical `name` prefix against our `tdot_code`), it only costs requests.
- Total across the 131 labels: 435,160 items = 4,415 requests at 100 per page. Six labels
  hold 263,000 of them: Covercraft 92,560, Corbeau Seats 57,303, Power Stop 34,550,
  WeatherTech 29,428, EBC Brakes 26,860, Fuel 22,593. Median label: 719 items.
- Six labels return almost nothing (Alloy USA 14, Element Fire Extinguisher 8, Maxxis 18,
  Pro Comp Suspensions 1, Rubicon Express 6, Smittybilt 2): either TDOT does not sell them
  or the label differs from TDOT's wording; the parity run will tell.

**Decision: hybrid per label.** Brand crawl when the label has at most
`TDOT_BRAND_CRAWL_MAX_ITEMS` (default 10,000) items: 125 labels, 1,779 requests. For the
six big labels, one fuzzy query per OUR product carrying that label (`term=<tdot_code>`),
matched by canonical part number; our product counts per label come from the DB at run
time (read-only sizing SQL before the first run). Expected night: about 2,000 to 2,500
requests, 1 to 1.5 hours at 1 s spacing with concurrency 2 (robots.txt asks 2 s on the
Magento host; the Klevu host is separate, we still stay polite). The first run picks the
cheaper shape per label automatically (`pages(total) <= ourProductsForLabel` ? crawl : per-product).

### Matching rule confirmed by the data

`competitor_sku` stays `tdot_code`. For a Klevu record, `name.split(' - ')[0]` is the TDOT
rendering of `"<label> <part>"`; compare `canonical(namePrefix)` with
`canonical(tdot_code)` where canonical = uppercase, strip `[-_\s]`, keep dots
(`lib/competitors/skuMatch.js`), after mapping the label through the same dictionary. The
record `sku` (`<token>-<part>`) is the fallback (part = everything after the first hyphen).
Products whose label never appears in TDOT data are reported per label in the summary.

### Read-only sizing SQL (Ricardo runs it in production before phase 1)

```sql
SELECT count(*) FROM "Product" WHERE tdot_url IS NOT NULL AND tdot_url <> '';
SELECT split_part(tdot_code, ' ', 1) AS label, count(*) FROM "Product" WHERE tdot_code <> '' GROUP BY 1 ORDER BY 2 DESC;
SELECT tdot_code, count(*) FROM "Product" WHERE tdot_code <> '' GROUP BY 1 HAVING count(*) > 1;
SELECT count(*), min(updated_at), max(updated_at) FROM "CompetitorProduct" WHERE competitor_id = 4;
```

## 5. Phase 1 delivered (2026-10-02)

Pure collector under `lib/competitors/tdot/` with 36 node:test cases and fixtures trimmed
from real Klevu answers (`test/lib/competitors/tdot/fixtures/`), no network in tests:

| Module | Exports | Role |
|---|---|---|
| `config/tdot.js` | `getTdotConfig(env)`, `DEFAULTS` | env with clamps, User-Agent from `SCRAPER_CONTACT_EMAIL` |
| `discoverConfig.js` | `parseApiKey`, `parseSearchDomain`, `discoverConfig` | Klevu key from the storefront HTML, search host from Klevu's config JSON, env fallback |
| `klevuClient.js` | `createKlevuClient`, `buildSearchUrl`, `PAGE_SIZE_MAX` | one request, typed errors with `retryable`, key never logged |
| `normalize.js` | `tdotCodeFromRecord`, `normalizeRecord(s)`, `dedupeItems` | record -> item, selling price rule, invalid reasons, cheapest duplicate wins |
| `match.js` | `canonicalTdotCode`, `buildTargetIndex`, `matchItems` | product-driven matching by canonical `tdot_code`, ambiguous (shared codes) reported |
| `plan.js` | `planLabels` | crawl vs per-product per label, request budget |
| `canaries.js` | `checkTdotRun`, `DEFAULT_THRESHOLDS` | `REQUEST_FAILED_RATIO`, `BELOW_MIN_MATCHED`, `PRICE_INVALID_RATIO` |
| `collect.js` | `collectTdot`, `labelOfProduct`, `TdotCollectError` | probe, plan, fetch with retry/delay/jitter, time and request budgets (`partial`), payload v1 |
| `legacyAdapter.js` | `toLegacyRows` | payload -> `{ tdot_price, tdot_code, sku, brand, product_url }` |

Env names: `TDOT_STOREFRONT_URL`, `TDOT_KLEVU_CONFIG_BASE_URL`, `TDOT_KLEVU_API_KEY`,
`TDOT_KLEVU_SEARCH_DOMAIN`, `TDOT_PAGE_SIZE`, `TDOT_REQUEST_DELAY_MS`, `TDOT_CONCURRENCY`,
`TDOT_REQUEST_TIMEOUT_MS`, `TDOT_MAX_PRICE`, `TDOT_BRAND_CRAWL_MAX_ITEMS`, `TDOT_MAX_REQUESTS`,
`TDOT_MAX_RUN_MINUTES`, `TDOT_LABEL_LIMIT`, `TDOT_MIN_MATCHED`, `TDOT_MAX_FAILED_REQUEST_RATIO`,
`TDOT_MAX_INVALID_RATIO`, plus the existing `SCRAPER_CONTACT_EMAIL`.

## 6. Phase 2 delivered (2026-10-02)

- `prisma/seeds/api-calls/tdot-api.js` is now a facade: `createTdotSource({ prisma, env, fetch, ... })`
  with `fetchRows({ dryRun, runId, fromSnapshot })` -> `{ rows, payload, snapshotPath }`; the legacy
  default export `tdotCost()` keeps its name and shape. It loads our targets
  (`Product` with a non-empty `tdot_code`), the labels from `vendors_prefix.js`, runs the
  collector, writes one snapshot per run under `prisma/seeds/logs/tdot/` (real runs also refresh
  `latest-snapshot.json`, see section 9) and returns the legacy rows.
  Escape hatch: `TDOT_SOURCE=parsehub` with `PARSEHUB_API_KEY` (and optional
  `PARSEHUB_TDOT_PROJECT`) from the environment, parsed exactly as before. No key literal.
- `prisma/seeds/seed-individual/seed-tdot.js`: `runSeedTdot({ prisma, source, startRun, argv, logger })`
  with the upsert SQL untouched except `updated_at = CURRENT_TIMESTAMP` and an
  `IS DISTINCT FROM` guard on the UPDATE (rows only rewritten when price, link or product
  changed); IngestRun `tdot` started and finished with counts; `--dry-run` (no writes);
  `--from-snapshot <file>`; one `SUMMARY` JSON line; exit code 1 on failure; the module no
  longer runs on require (CLI under `require.main === module`).
- Tests: `test/lib/competitors/tdot/tdotApiFacade.test.js`, `test/seeds/seedTdot.test.js`
  (prisma and run stubs, no network). Suite: 610 green.
- Alternate brand token: the collector probes TDOT's own sku token when it differs from our
  label ("Fox Racing" -> "FoxShox", 233 -> 880 items) and crawls with the term that returns more.

### Next (phase 2 tail, needs Ricardo)

- `TDOT_LABEL_LIMIT=3 npm run seed-tdot -- --dry-run` against production reads products
  (SELECT) and writes one IngestRun bookkeeping row; then the full dry run via kamal
  (about 1 to 1.5 h) for the parity numbers.
- `.env.production` and `.kamal/secrets`: no new secret is required (`SCRAPER_CONTACT_EMAIL`
  already exists); `TDOT_*` tunables are optional.

## 7. Phase 4 prepared (2026-10-02, not enabled)

- `config/cron-jobs.js`: job `seed-tdot` ("TDOT Competitor Prices"), `CRON_SEED_TDOT_ENABLED === 'true'`
  (default off), `CRON_SEED_TDOT_SCHEDULE` default `43 1 * * *`; `config/deploy.yml` carries
  both with `"false"`; `.env.example` documents every `TDOT_*` tunable.
- `prisma/seeds/seed-individual/seed-all.js`: `seed-tdot` removed from `otherSeeds` (commented
  with the reason). Consequence after the deploy: TDOT prices stop refreshing until the cron is
  switched on; acceptable because the ParseHub data was last refreshed in March 2026.
- Runbook: `docs/COMPETITOR-TDOT.md`. Stale doc lines fixed in dd-002, dd-009, dd-011, dd-018,
  the data-sync PRD and the multi-vendor PRD ("Tire Discounter" was wrong: `tdot_code` is the
  TDOT Performance competitor label).
- Limited production dry run (3 labels, run 1169): 70 requests, 64 matched, 0 missing, 93 s.
  Full dry run (run 1170) started 16:43 UTC; numbers go to section 8 when it ends.

## 8. Phase 3: full production dry run (IngestRun 1170, 2026-10-02 16:43 to 17:29 UTC)

| Measure | Value |
|---|---|
| Labels planned / crawled / per product | 130 / 101 / 29 |
| Requests / failed | 3,058 / 0 |
| Raw records / invalid (Klevu category hits) / duplicates | 184,712 / 2,415 / 54,079 |
| Matched products (rows the seed would write) | **35,870** (creates 4,537, updates 31,333) |
| `tdot_code` without a product | 0 |
| TDOT items we do not sell | 92,348 |
| Ambiguous codes (two of our products share one `tdot_code`) | 553, of which 550 are a trailing-hyphen duplicate in our catalog (`AFE-50-70081D` and `AFE-50-70081D-`) |
| Duration | 46 minutes, concurrency 2, 1 s delay |

Today competitor 4 holds 31,333 rows, so the first real run adds 4,537 products and refreshes
every price with a verifiable source. Proposed canary floor: `TDOT_MIN_MATCHED=28000`
(about 78% of the measured run), to be set in `config/deploy.yml` with the cron.

### Labels with zero matches (17) and what they mean

- Not sold by TDOT (the probe returns other brands): Alloy USA, Corbeau Seats, Smittybilt,
  Rubicon Express, Pro Comp Suspensions, MOPAR PERFORMANCE. The collector now marks them
  `not-on-tdot` and spends no requests on them (Corbeau alone cost 481 queries in this run).
- Spelled differently by TDOT: "Fox Racing" is "Fox Shox" there (880 items); "Pro Comp Tires"
  appears as "Pro Comp Wheels". Data fix for the owner of `vendors_prefix.js`: set
  `tdot_code` to TDOT's wording (`Fox Shox`), then re-seed products.
- No overlap with our part numbers although the brand exists on TDOT: Draw-Tite, Eibach,
  Holley, Maxxis, Nitto, Omix-ADA (53 items), T-Rex, Yokohama, Covercraft. Nothing to do.

### Other observations

- `salePrice` was never below `price` in 35,870 items; TDOT does not seem to publish
  promotions through this field. The rule stays, the log keeps `oldPrice`.
- Klevu category records (`id = categoryid_*`, no sku) are now counted apart
  (`categoryCount`) so they do not feed the invalid-price canary.
- The 550 trailing-hyphen duplicates are a catalog data issue (two Product rows for one part);
  the seed keeps writing one row per `tdot_code`, as before.

## 9. Review fix wave (2026-10-02, three read-only reviewers on the diff)

Back-end, silent-failure and data reviewers found no data-corruption defect and a list of
operational holes. All fixed before the first commit; suite 630 green. Verified against
production with dry runs 1173 (3 labels through Klevu, same numbers as 1169), 1177 and 1178
(`--from-snapshot` refused below the floor, accepted with the floor lowered) and 1179 (bogus
file refused).

Collector (`lib/competitors/tdot/collect.js`):

- A partial run no longer relaxes the canary floor (it used to zero `minMatched`); partial
  is reported, the floor still applies.
- `not-on-tdot` is decided only by the brand probe of our own label (a foreign brand token
  that happened to return records could flip it before). Category records never count as
  brand items.
- `withRetry` retries only retryable errors; a definitive HTTP error (4xx other than 429) is
  fetched once. `httpAttempts` counts every attempt, `requests` counts logical requests.
- Circuit breaker: `TDOT_CONSECUTIVE_FAILURE_LIMIT` (default 10) consecutive failures abort
  with `TDOT_SOURCE_UNAVAILABLE`.
- Over-budget labels are reported as `over-budget`, distinct from `probe-failed`.
- Labels are fetched largest first; per-product queries use `TDOT_PER_PRODUCT_RESULTS` (20).
- Duplicate TDOT records for one code: the exact string match to our `tdot_code` wins, then
  the cheapest. Items carry `label`, `discount`, `oldPrice`; `unmatchedSample` moved per label.

Facade (`tdot-api.js`):

- One snapshot file per run (`tdot-run-<id>[-dry-run]-<timestamp>.json`); only real runs
  refresh `latest-snapshot.json`, so a dry run can no longer overwrite the last good snapshot.
- `--from-snapshot` validates the file (schema version 1, source `tdot`, items array) and
  reruns the canaries on its `collection`; ParseHub calls carry a timeout; `tdotCost.last` is
  reset per call; `describe()` gives `IngestRun.sourceRef` the real source.
- `discoverConfig` uses one `AbortSignal` per request.
- Found by the manual check of these paths: `--from-snapshot` and ParseHub demanded
  `SCRAPER_CONTACT_EMAIL` although they make no Klevu request; `config/tdot.js` now exposes
  `getTdotOfflineConfig(env)` (thresholds and timeout only) for them.

Runner (`seed-tdot.js`):

- Exit codes `0 / 1 / 2`; a partial collection writes, records the IngestRun as `partial` with
  the reason, and exits `2`. Dry runs record status `dry-run` (they never counted as success).
- Guards independent of the source: `TDOT_NO_ROWS` when nothing matched, `TDOT_MATCH_DROP`
  when the matched rows fall below `TDOT_MATCH_DROP_RATIO` (0.8) of the last successful
  non-dry run's `sourceRowCount` (which now holds the rows written).
- Two products sharing a `tdot_code` resolve deterministically (active first, then sku) instead
  of last-wins; `rowsSkipped` = rows already up to date; failures to record the outcome are
  logged, never swallowed; canary code and message are stored in `IngestRun.error`.
- The snapshot of a real run is archived to Spaces (`createLogArchive().archiveFile`),
  injectable in tests.
- `CRON_TEST_COMMAND` default moved from `seed-tdot` to `seed-orders` (production already
  used that value).

Left as is, on purpose: `maxFailedRequestRatio` stays 0.1 until the parity nights show the
real failure rate; the 550 trailing-hyphen catalog duplicates and the "Fox Racing" label are
data fixes for the owner of `vendors_prefix.js` (phase 5).

## 10. ParseHub removed and end-to-end write verified (2026-10-03)

Ricardo decided ParseHub is no longer used. The `TDOT_SOURCE=parsehub` path, its parser and
its tests are deleted; a test pins that `TDOT_SOURCE` is ignored and no request goes to
ParseHub. The key is still live in the Parts Engine, Northridge and Omix inventory feeds.

The write path had only been tested with stubs, so the real seed ran against a throwaway
Postgres 16 (all migrations applied) loaded with the 111 production products of three labels
(AEM, aFe Power, Airaid) and their 69 production competitor-4 rows, read with SELECTs only.
Axiom and the Spaces archive were switched off for these runs. Production has no duplicate
`competitor_sku` for competitor 4 (runbook check, 0 rows).

| Sandbox run | Scenario | Result |
|---|---|---|
| 1 | first real write | 64 matched, 7 inserted, 57 updated (46 prices and all 57 links changed: ParseHub stored the search URL), every row's price, link and owner equal to the snapshot, 0 duplicate keys, the 12 rows TDOT no longer shows untouched |
| 2 | immediate rerun | 0 inserted, 0 updated, 64 skipped, no `updated_at` moved |
| 3 | one price and one link tampered | exactly those 2 rows rewritten |
| 4 | `TDOT_MIN_MATCHED=1000` | `BELOW_MIN_MATCHED`, exit 1, tampered price untouched |
| 5 | request budget 30 | partial with 17 matched, refused by `TDOT_MATCH_DROP`, exit 1, nothing written |
| 6 | same, drop guard relaxed | status `partial`, 1 row fixed, exit 2 |
| 7 | storefront unreachable | `TDOT_CONFIG_NOT_FOUND`, exit 1 |
| 8 | `--dry-run` | status `dry-run`, nothing written |
| 9, 10 | short run after the partial, then a full run | refused against the baseline of 64; full run healed the tampered row |

Defect found and fixed by this check: the match-drop baseline counted `partial` runs, so a
partial run would have lowered the bar for the next one. The baseline is now the last
`success` run only (test added).
