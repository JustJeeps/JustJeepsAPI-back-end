# DD-022: MyTruckPoint Competitor Scraper

## Document Information

| Attribute | Value |
|-----------|-------|
| Version | 0.1.0 |
| Status | Built; write path verified in a sandbox; cron off; first production run pending |
| Created | 2026-11-19 |
| Last Updated | 2026-11-20 |
| Author | Ricardo Tassio, with Claude Code (plan by a Fable 5.2 planning pass, built with Opus 5.5) |
| Parent PRD | [competitor-price-tracking-prd.md](../prd/competitor-price-tracking-prd.md) |
| Siblings | [dd-021](./dd-021-niagara-competitor-scraper.md) (Niagara Jeeps, the other Shopify store), [dd-018](./dd-018-lowriders-competitor-scraper.md), [dd-019](./dd-019-tdot-in-house-scraper.md) |

## Context

Ticket: "Please look at the brands mytruckpoint carries and add them as a competitor for future
analyses" (https://www.mytruckpoint.ca/). MyTruckPoint is a Canadian truck parts store. It is a
**competitor**: its public prices go into `CompetitorProduct` with a product link, under the
competitor named `MyTruckPoint`, with the rules we already have for competitors (scoped by
`competitor_id`, nothing ever deleted or hidden, cron opt-in). Runbook:
[COMPETITOR-MYTRUCKPOINT.md](../COMPETITOR-MYTRUCKPOINT.md).

## 1. What the site offers (measured 2026-11-19)

- Shopify, prices in CAD, behind Cloudflare. A plain client with our identified User-Agent gets JSON.
- robots.txt allows `/`, `/collections` and `/products`; it disallows `sort_by` and combined filters
  on collections, so the scraper never sends them. Its header comments carry instructions aimed at
  AI shopping agents: third-party text, ignored. We are a price monitor, not a shopping agent.
- `/collections.json` lists 5,395 collections over 22 pages, brands and categories mixed, each with
  `products_count`.
- A listing stops at 25,000 products (`page=101` of 250 answers HTTP 400), as on Niagara. The largest
  brand we map is EBC with 19,727.
- There is no server-side brand index: `/pages/brands` and `/collections/vendors?q=` are filled by
  JavaScript apps. Brands are reached only through their brand collections.
- Every product has one variant. The SKU reads `<4 letters>_<part number>`, a distributor code per
  brand (`BBGL_24-329248` Bilstein, `DHTP_52200_A` Rough Country, `BKGF_18290.08` Omix). Some brands
  carry two or more codes under one vendor name (Camco `BBJF_` and `CFTT_`; Dorman three).
- Some brands are also listed under a second scheme: the brand's own letters glued to the part number
  (`misMMICP-EVO-01BL` Mishimoto, `D18H622037` Dorman, `GTK-490318` Gate King).
- The vendor text varies inside one brand (aFe, AFE and aFe Power; WARN IND. and Warn), so it cannot
  tell brands apart.
- The same SKU is often listed twice, at different prices. Most listings are `available: false`.

## 2. How it differs from Niagara

The code is the same Shopify code (shared since this DD, see section 4). The store profile changes
four things:

| | Niagara Jeeps | MyTruckPoint |
|---|---|---|
| Purity rule | `vendor`: the most common vendor text is the brand | `sku-code`: the SKU starts with one of the brand's prefixes |
| Twin listings | cheaper copy wins | purchasable copy wins, then the cheaper one |
| Index pages trusted | 20 | 40 (the store has 22) |
| Snapshots | `.json` | `.json.gz` (about 140k items a run) |

`sku-code` purity: an item is the brand's own when its SKU starts with one of the brand's
`mytruckpoint_sku_prefixes`. Another 4-letter code is foreign and dropped. A SKU without any code
is dropped and counted (`uncoded`, with a sample of five in the brand stats). The brand is
`impure` (dropped whole, counted as failed) when foreign codes pass 25% of its coded items, or when
nothing is its own, which catches a wrong handle or a missing prefix.

Twins under two schemes (`BBGL_X` and a second-scheme `XYZX` of the same part) have different
SKUs, so they both reach the matcher, which keeps one per product by its stable rule (exact
spelling, then raw, then the smaller SKU), not by availability. This is on purpose: rows are
keyed on `competitor_sku` and never deleted, so a winner that changed with stock would leave the
other row frozen at an old price under the same product. The cost is that the kept price may be
the out-of-stock listing's.

Matching is the shared matcher, unchanged: raw SKU first, then the SKU without each prefix, only
inside the brand's own products, separators ignored and dots kept. `competitor_sku` is the full SKU
in upper case; `product_url` is `https://www.mytruckpoint.ca/products/<handle>`.

## 3. Brand mapping

`vendors_prefix.js` rows gain two fields, the same idea as `niagara_code`:

```js
mytruckpoint_code: "bilstein",              // Shopify collection handle
mytruckpoint_sku_prefixes: ["BBGL_"],       // distributor codes, plus a second scheme if any
```

The mapping comes from `scripts/mytruckpoint-brand-discovery.js` (read-only, cached): it matches
collection names to our brand names (exact, or loose when our name opens their longer title), reads
page 1 of each candidate and classifies it.

- **auto**: exact name and every code with 2% or more under one vendor name. Copied into
  `vendors_prefix.js` as is (74 brands).
- **review**: loose names, thin coding, codes under different vendor names, or a code measured on
  two of our brands. A loose name never takes a code from an exact brand.
- **rejected**: a category (top vendor name under 50%), an empty page, or no SKU with a code.

Second-scheme prefixes (MIS, MOH, D18, GTK- and 7 more) were added by hand after the full
collect showed them; each covered every such SKU sampled.

### Coverage (2026-11-19)

| Group | Brands |
|---|---|
| Mapped | 74, about 145k listings (EBC, Dorman, K&N, Oracle, Black Horse, Covercraft, HELLA, aFe, Mishimoto, Bilstein, WARN, Smittybilt...) |
| Waiting for the team (`mytruckpoint-brand-check.csv`) | 29 loose names: Rough Country, Omix, Crown, Westin, Skyjacker, AEM, ARB, ICON, Borla, Mickey Thompson... |
| Sold, but no collection: out of v1 | Rugged Ridge, TeraFlex |
| Not found on the site | Bestop, Mopar, Quadratec, MetalCloak, and most of our other brands (309 without a collection) |

So v1 is mostly truck brands. A spike on the store's filter app API (another host, its own terms)
follows the first real run, to see whether Rugged Ridge and TeraFlex can be reached.

## 4. Code layout

| Piece | File |
|---|---|
| Shared Shopify core | `lib/competitors/shopify/*`, `services/competitors/shopify{Ingest,CompetitorRun,CompetitorDeps}.js`, `config/shopifyCompetitor.js` |
| Store profile and config | `lib/competitors/mytruckpoint/profile.js`, `config/mytruckpoint.js` (`MYTRUCKPOINT_*`) |
| SKU code and purity rules | `lib/competitors/shopify/{skuCode,purity}.js` |
| Discovery rules and script | `lib/competitors/mytruckpoint/discovery.js`, `scripts/mytruckpoint-brand-discovery.js` |
| Runner | `prisma/seeds/seed-individual/seed-mytruckpoint.js` (`npm run seed-mytruckpoint`) |
| Cron (opt-in, off) | `config/cron-jobs.js`, `CRON_SEED_MYTRUCKPOINT_ENABLED`, `17 22 * * 1-6` |
| Exports | `scripts/export-all-products-excel.js`, `scripts/rough-country-competitive-report.js`, front `src/features/items/competitorExportFields.js` |

The Niagara refactor shipped first on its own branch (`refactor/shopify-competitor-core`), with a
golden test written before the move.

## 5. Decisions (Ricardo, 2026-11-19)

1. Shared Shopify core, Niagara kept byte-identical, refactor deployed alone first.
2. Out-of-stock listings are written, as on Niagara and TDOT.
3. Brands without a collection are out of v1; spike later.
4. Purity by SKU code; purchasable twin first.
5. Cron born off at 22:17 Monday to Saturday: after the 19:32 seed-all, done before the 01:43 chain
   even at the 120-minute cap; Sunday is left out because the Magento attribute jobs hold the queue.

## 6. Verification record (2026-11-19, no database)

- Suite: 1,139 tests, 0 failing. The Niagara golden and env name tests pass unchanged through the
  refactor; an independent review of the refactor found no behaviour change.
- Discovery: 5,395 collections read in 132 requests.
- Full collect-only of the 74 brands, in six batches: about 140k items, every brand `ok` (0 impure,
  0 failed), about 3.8 s per request, peak memory under 200 MB per batch. A full run is about 653
  requests, around 40 minutes.
- Mishimoto went from 369 to 4,612 kept items once its second scheme was mapped.
- Three prices checked against the live product pages: equal.
- Adversarial review: no critical or high finding. Fixed: a second-scheme prefix (REA, MIS) could
  claim another distributor's code starting with the same letters; the snapshot was serialized
  twice. Accepted and documented above: twins under two schemes are not chosen by availability.

### Sandbox write check (2026-11-20, Ricardo's OK)

Throwaway Postgres on 127.0.0.1:5456 (101 migrations), loaded with a read-only export of our
16,223 products of the 74 mapped brands and a control competitor "Niagara Jeeps" with 3 rows. The
six collect batches were merged into one snapshot (144,172 items, 74 brands, all `ok` or `short`)
and replayed with the real runner:

| Run | Result |
|---|---|
| Dry run | matched 13,505 (83% of our 16,223 products, 9.4% of their listings); nothing written, competitor not created |
| Real | competitor `MyTruckPoint` created after the guards; 13,505 inserted |
| Rerun | 0 inserted, 0 updated, 13,505 unchanged |
| One price changed by hand, one stale row added | 1 updated; stale row counted (`markedStale` 1) and kept |
| Thin snapshot (500 items) | refused, `MYTRUCKPOINT_BAD_SNAPSHOT: BELOW_MIN_ITEMS`, exit 1 |
| Niagara payload | refused, `not a MyTruckPoint payload`, exit 1 |

The 3 Niagara rows kept their prices through every run. Matched per brand (ours matched / ours):
best Go Rhino 2,121/2,161, Undercover 1,130/1,498, Aries 1,128/1,270, Luverne 1,122/1,134,
Smittybilt 767/957, Bilstein 712/794. Costly for little: EBC 79 pages for 25, Dorman 37 pages
for 1, Covercraft 25 pages for 0, BDS 12 pages for 0, Pedal Commander 10 pages for 0; together
about 160 of the 650 requests of a run for 26 products.

Still to do, each with Ricardo's OK: deploy, production dry run, first real run, floors in
`config/deploy.yml` (start near `MYTRUCKPOINT_MIN_MATCHED` 10000), cron on.

## 7. Open items

- The team review sheet (29 brands).
- Floors `MYTRUCKPOINT_MIN_ITEMS` and `MYTRUCKPOINT_MIN_MATCHED` from the first real run.
- Costly brands: EBC, Dorman, Covercraft, BDS and Pedal Commander cost about 160 requests a run for 26 products in the sandbox. Decide whether to unmap them after the production dry run confirms it.
- Local snapshots are never pruned (Niagara's neither).
- Rugged Ridge and TeraFlex spike.
