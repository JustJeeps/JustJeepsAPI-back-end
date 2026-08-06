# Vendor Feeds on DigitalOcean Spaces

Vendor price and inventory files (CSV/XLSX) live in a private DigitalOcean Spaces bucket instead of being baked into the Docker image. Every upload becomes a new immutable object. A Postgres catalog (`FeedArtifact`) records what exists, its SHA-256, who uploaded it and when. Seeds read the latest complete batch through a local cache.

## Why

Before this, feed files were copied into the image from the deployer's working directory. Data froze at build time, a 459MB gitignored file broke the daily sync twice a day, one feed (Omix) failed silently for weeks, and vendor cost data was exposed in git history and registry images.

## Architecture

| Layer | What | Where |
|---|---|---|
| Acquisition | FTP fetch cron (Keystone), settings panel upload, CLI | `services/feeds/`, `scripts/feed-*.js` |
| Landing zone | immutable objects `feeds/{feed}/{YYYY}/{MM}/{ts}-{sha8}-{file}` | Spaces bucket (`DO_SPACES_FEEDS_BUCKET`, falls back to `DO_SPACES_BUCKET`) |
| Catalog | `FeedArtifact` rows + `IngestRun.artifactBatchId` | Postgres |
| Ingestion | existing staged pipeline (`lib/ingest/`), unchanged | seeds |
| Serving | Postgres (`VendorProduct` / `Product`), unchanged | app |

Multi-file feeds (Keystone = `Inventory.csv` + `SpecialOrder.csv`) share a `batchId`. A batch only becomes current when ALL expected files are catalogued, so a partial upload can never feed the sync.

## Legacy paths preserved (feed-sync)

Seed scripts keep reading their original paths under `prisma/seeds/api-calls/`. The `feed-sync` step (stage 0 of `seed-all`, also `npm run feed-sync`) materializes the current batch of every feed into the verified cache and puts an atomic **symlink** at each legacy path, for example:

```
prisma/seeds/api-calls/keystone_files/Inventory.csv -> /app/feed-cache/keystone-ftp/<batchId>/Inventory.csv
```

So no seed script changes how it reads files. Rules: a feed with no catalogued batch keeps its existing local file (warning only, visible in the digest); a real failure (Spaces down with no cache, hash mismatch) makes feed-sync exit 1 and show up in the seed-all summary. Orphan files with no reader are preserved under `feeds/_archive/` in the bucket via `npm run feed-upload -- --archive <files>` and are not part of the registry or the sync.

## Key modules

- `config/feeds.js` - feed registry (names, expected files, freshness thresholds)
- `lib/feeds/feedStore.js` - S3 client factory (injectable, MinIO-friendly via `DO_SPACES_FORCE_PATH_STYLE`)
- `lib/feeds/catalog.js` - register/getCurrentBatch/quarantine/listing (prisma injected)
- `lib/feeds/materialize.js` - downloads the current batch into `FEED_CACHE_DIR` with sha verification and sentinel files; typed failures (`FEED_NO_ARTIFACT`, `FEED_HASH_MISMATCH`, `FEED_STALE`, `FEED_STORE_UNAVAILABLE`); falls back to the last intact cached batch if Spaces is down (marked stale, never silent)
- `lib/feeds/keystoneFtp.js` - FTPS client, credentials from `KEYSTONE_FTP_USER/PASS` env
- `services/feeds/keystoneFetchService.js` - download, sanity gates, upload both files, then catalog

## How to

- Upload a feed manually (panel): Settings page, Vendor Feeds card, per feed Upload button (triage users only, max 100MB per file).
- Upload via CLI: `npm run feed-upload -- <feed> <files...> [--note "..."] [--by user]`. Multi-file feeds need all files in one run, or complete a partial batch with `--batch <id>`.
- Fetch Keystone now: `npm run feed-fetch-keystone` (cron `feed-fetch-keystone` runs it at 4:47 and 16:47 once `CRON_FEED_FETCH_KEYSTONE_ENABLED=true`).
- Materialize locally: `npm run feed-materialize -- <feed>`.
- Inspect: `GET /api/ingest/feeds` (current batch, age, stale flag, last runs) and `GET /api/ingest/runs?feed=...`. Stale or missing feeds also show as failures in the daily cron digest email.
- Kill a bad batch: `npm run feed-quarantine -- <feed> [batchId] --note "why"` (no batchId acts on the current batch; `--list` shows the batches of the feed). The feed falls back to the previous complete batch, so run `npm run feed-sync -- <feed>` afterwards to point the legacy paths at it. If no earlier complete batch exists the feed is left with none on purpose: the vendor scripts then fail loudly instead of reading condemned data.

## Rollout status

The code is dormant until the bucket exists: `feed-sync` warns and keeps local files while `DO_SPACES_*` is absent or the catalog is empty, so nothing breaks. To activate: provision the Spaces bucket, fill `DO_SPACES_*` in `.env.production`, create `/var/lib/justjeeps-api/feed-cache` on the droplet, backfill artifacts (`feed-fetch-keystone` + `feed-upload` for the manual feeds, `--archive` for orphans), deploy, then set `CRON_FEED_FETCH_KEYSTONE_ENABLED=true`. After one green seed-all cycle the feed files can leave git and the docker image (cleanup phase).
