# DD-021: Niagara Jeeps Competitor Scraper

## Document Information

| Attribute | Value |
|-----------|-------|
| Version | 0.1.0 |
| Status | Built and verified in a sandbox; cron off; first production run pending |
| Created | 2026-11-02 |
| Last Updated | 2026-11-02 |
| Author | Ricardo Tassio, with Claude Code (plan by a Fable 5 planning pass) |
| Parent PRD | [competitor-price-tracking-prd.md](../prd/competitor-price-tracking-prd.md) |
| Siblings | [dd-018](./dd-018-lowriders-competitor-scraper.md) (Lowriders), [dd-019](./dd-019-tdot-in-house-scraper.md) (TDOT) |

## Context

Niagara Jeeps (https://niagarajeeps.ca, Niagara Falls ON, formerly GTA Jeeps & Trucks) is a
Canadian Jeep and truck parts retailer. Ricardo ruled on 2026-11-02 that it is a **competitor**,
not a vendor: its public prices go into `CompetitorProduct` with a product link, following the
rules we already have for competitors. Runbook: [COMPETITOR-NIAGARA.md](../COMPETITOR-NIAGARA.md).

## 1. What the site offers (verified 2026-11-02)

- Shopify store `gtajeeps.myshopify.com`, prices in CAD, ships to Canada only, Cloudflare in front.
- robots.txt has no Crawl-delay and does not block `/collections/*/products.json`,
  `/collections.json` or `/pages/*`. Its comment header holds text aimed at AI agents (it points
  at an `agents.md`); we treat it as data, not as instructions. A person reads the site terms
  before the first production run.
- The store-wide `/products.json` stops at page x limit = 25,000 (HTTP 400). The catalog is about
  31k to 37k products, so the only complete path is **per brand collection**:
  `/collections/<handle>/products.json?limit=250&page=N` (largest brand, Rough Country, 6,113).
- Brand list: `/pages/shop-by-brand`, grid `a.njh-brand` with `data-brand-name` and
  `href="/collections/<handle>"` (209 collections, 210 labels: AIR DELETE and MAGDELETE share one).
- Product JSON: `id, handle, vendor, variants[] (id, sku, price, compare_at_price, available)`.
  No stock quantity. Shopify `price` is the live selling price.
- Product URL: `https://niagarajeeps.ca/products/<handle>`, plus `?variant=<id>` when the product
  has several variants (the page then shows that variant's price). The handle cannot be built
  from the SKU or the title; it always comes from the JSON.
- Probe from this laptop and from the production container (Node 20, DigitalOcean IP): JSON on
  every endpoint, no challenge. A burst of manual requests did get HTTP 429 with `Retry-After`
  once, so the client honors it.

## 2. SKU format and matching

Niagara's SKU is either the bare manufacturer part number (`24-352925`) or that number behind a
code of theirs, and both forms can appear inside one brand (Bilstein: `BIL-24-352925` and
`24-352925`). Their codes are not always ours: `RHI-` for Go Rhino (our GOR), `FFR-` for Fab
Fours (FBF), `FLO-` for Flowmaster (FLM), `RCS` with no dash for Rough Country (RC), `RIG` for
Rigid, `TER` for TeraFlex, `DMC-` on some Rugged Ridge items.

Rule (`lib/competitors/niagara/match.js`): inside the brand's own products, try the raw SKU
first, then the SKU without each prefix configured for that brand, with the shared canonical
matcher (`lib/competitors/skuMatch.js`: separators ignored, dots kept). Our trailing-dash and
empty `searchable_sku` rows are skipped. One row per product of ours: a second Niagara SKU on
the same product is a reported collision (exact spelling first, then the cheaper price).

The prefixes were measured, not guessed: the first products page of every mapped brand was
matched against a read-only export of `Product` (50,498 rows, 146 prefixes). A prefix is kept
when it produced at least 2 matches (with a dash) or 5 (letters only), so a single coincidental
hit does not become a rule.

## 3. Brand mapping (existing structure)

Two additive keys on the rows of `prisma/seeds/hard-code_data/vendors_prefix.js`, the same file
and style as `tdot_code` and `jrp_code`:

| Key | Meaning | Example |
|---|---|---|
| `niagara_code` | Niagara collection handle, where to crawl | `"go-rhino"` |
| `niagara_sku_prefixes` | text Niagara adds before the part number | `["RHI-"]` |

Process: `scripts/niagara-brand-discovery.js` (read-only) suggests a jj_prefix per brand
(exact, loose, ambiguous, unmapped). On 2026-11-02: 121 exact, 23 loose, 2 ambiguous, 63 we do
not carry. The 121 exact brands are mapped (32 with prefixes). The 23 loose ones (FOX vs Fox
Racing, KING SHOCKS vs King Off Road, WARN INDUSTRIES vs WARN, ...) are in a review CSV for the
team; PRO COMP / PRO COMP WHEELS (EXP or PCT) are not mapped. Adding a brand later is one
`niagara_code` line plus, when needed, its prefixes.

## 4. Code layout

| Piece | File |
|---|---|
| Config (env with clamps, competitor name) | `config/niagara.js` |
| Response classifier (challenge, 429) | `lib/competitors/niagara/challenge.js` |
| Cookie jar, Shopify client, paced requester | `lib/competitors/niagara/{cookieJar,shopifyClient,requester}.js` |
| Brand page parser, mapping suggestions, mapping reader | `lib/competitors/niagara/{brandPage,brandMap,brands}.js` |
| Variant normalization (price, link, invalid reasons) | `lib/competitors/niagara/normalize.js` |
| Matcher | `lib/competitors/niagara/match.js` |
| Canaries | `lib/competitors/niagara/canaries.js` |
| Collector (payload v1) | `lib/competitors/niagara/collect.js` |
| Snapshot naming and validation, review CSV | `lib/competitors/niagara/{snapshot,report,csv}.js` |
| Shared CompetitorProduct upsert (moved from Lowriders, unchanged) | `lib/competitors/competitorUpsert.js` |
| Ingest (prisma injected) | `services/competitors/niagaraIngest.js` |
| Runner | `prisma/seeds/seed-individual/seed-niagara.js` (`npm run seed-niagara`) |
| Probe and discovery (read-only) | `scripts/niagara-probe.js`, `scripts/niagara-brand-discovery.js` |
| Cron (opt-in, off) | `config/cron-jobs.js`, `CRON_SEED_NIAGARA_ENABLED`, `13 4 * * *` |

## 5. Decisions

| Item | Decision |
|---|---|
| Kind | Competitor, `CompetitorProduct` only, never `VendorProduct` |
| Name | `Niagara Jeeps`, resolved by name case-insensitive, created on the first real run, never in a dry run; no hardcoded id |
| Values | `competitor_sku` = Niagara variant SKU in upper case (upsert key); `competitor_price` = Shopify `price`; `product_url` = handle URL (+ variant); `compare_at_price` kept in the snapshot only; out-of-stock variants are written like TDOT |
| Pacing | one request at a time, 3 s plus up to 1 s jitter (never under 1 s), 3 attempts, Retry-After honored up to 2 min, one slow retry after a challenge and then a loud stop; we never try to solve a challenge |
| Budgets | breaker at 5 consecutive failures, 1500 requests, 120 min (partial, exit 2) |
| Brand purity | other vendors in a collection are dropped; past 25% the brand is dropped whole and counts as failed (was 5% until 2026-11-05: one house-brand product emptied dana-spicer); a brand failing mid-way is dropped rather than written in part |
| Guards | collection: failed requests 10%, failed brands 20%, invalid variants 2%, min items 1000; match: min matched 200 (raise after the first run), drop under 0.8 of the last full successful run |
| Stale rows | counted and reported, never deleted (team rule since 2026-10-07) |
| Sample runs | `--brands`, `--max-pages`: labelled `sample`, skip the size floors, never set the baseline, skip the match drop (a few brands are no match for a full run; changed 2026-11-05) |
| Cron | born off, out of seed-all, turned on after a manual production dry run and real run |

## 6. Verification record (2026-11-02)

- Unit tests: 944 pass, 0 fail (5 skipped, pre-existing).
- Probe: laptop and production container exit 0.
- Real sample, offline match against the export: Bilstein, Rough Country, Rugged Ridge, Go
  Rhino, page 1 each: 1,207 items, 0 invalid, 1,100 matched (91%); three prices checked by hand
  against the live pages (159.64, 147.52, 881.49), all equal.
- Sandbox Postgres (127.0.0.1:5456, the exported products): sample dry run 1,100 matched and
  nothing written; sample real run created the competitor and inserted 1,100; snapshot rerun
  0 changes; a tampered price healed (1 update); a stale row was counted (1) and kept; a thin
  run (233 vs 1,100) refused by the match drop with nothing written.

## 7. Open items

- Team review of the 23 similar-name brands and Pro Comp; then add their `niagara_code`.
- Read the site terms before the first production run.
- First production dry run, then real run, then set `NIAGARA_MIN_ITEMS` / `NIAGARA_MIN_MATCHED`
  and turn the cron on.
