# Vendor Feeds on DigitalOcean Spaces

Vendor price and inventory files (CSV/XLSX) live in a private DigitalOcean Spaces bucket instead of being baked into the Docker image. Every upload becomes a new immutable object (never overwritten in place). A Postgres catalog (`FeedArtifact`) records what exists, its SHA-256, who uploaded it and when. Seeds read the latest complete batch through a local cache. A daily retention job keeps only the 2 newest versions of each feed file in the bucket (see Retention below).

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

### Carry-forward on upload

An upload (panel or `npm run feed-upload`) does not have to include every file of a multi-file feed. Each file that was not sent is carried forward from the newest stored copy **of that file name**, whatever batch it sits in, and the new batch is registered with all of them. The lookup is per file, not "the current batch", so a feed that gains a file keeps accepting uploads during the transition: the old files are carried and only the new one has to be sent. A file that was never stored cannot be carried; the upload is refused with `409 FEED_BATCH_INCOMPLETE` and `missing` lists exactly those files.

### Quadratec: three files since Oct 2026

`quadratec` = `quadratec_wholesale.csv` (inventory) + `pricingSheet_quad.xlsx` (gold sheet, item prices) + `pricingKit_quad.xlsx` (gold kit, kit prices). Up to Sep 2026 the kits were rows inside the gold sheet; Quadratec now exports them in a separate file. The kit is **required**: `seed-quadratec` deletes the `VendorProduct` rows missing from the files, so a batch with the sheet alone would remove the ~6k kit rows, and the 0.5 shrink guard does not catch a 6% drop. Right after the deploy that added the kit, no batch covers all three files: the panel shows the feed as "no data", the digest reports it as having no batch, feed-sync removes its Quadratec symlinks and `seed-quadratec` / `seed-quad-inventory` fail in seed-all, until the sheet and the kit are uploaded together (the CSV is carried forward). Upload them right after the deploy.

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
- `lib/feeds/keystoneFtp.js` - FTPS client, credentials from `KEYSTONE_FTP_USER/PASS` env; byte resume waits for the previous write stream to close before measuring the file, and the final size is checked against the vendor's `SIZE` (a mismatch discards the download)
- `lib/feeds/csvIntegrity.js` - streaming quote-parity check (a line with an odd number of quotes means a stitched download; csv-parser would buffer the rest of the file until OOM)
- `services/feeds/keystoneFetchService.js` - download, sanity gates (minimum size, size vs current batch, VCPN header, quote parity), upload both files, then catalog

## How to

- Upload a feed manually (panel): Settings page, Vendor Feeds card, per feed Upload button (triage users only, max 100MB per file).
- Upload via CLI: `npm run feed-upload -- <feed> <files...> [--note "..."] [--by user]`. Multi-file feeds need all files in one run, or complete a partial batch with `--batch <id>`.
- Fetch Keystone now: `npm run feed-fetch-keystone` (cron `feed-fetch-keystone` runs it at 12:47 once `CRON_FEED_FETCH_KEYSTONE_ENABLED=true`, after the vendor's publishing window).
- Materialize locally: `npm run feed-materialize -- <feed>`.
- Inspect: `GET /api/ingest/feeds` (current batch, age, stale flag, last runs) and `GET /api/ingest/runs?feed=...`. Stale or missing feeds also show as failures in the daily cron digest email.
- Kill a bad batch: `npm run feed-quarantine -- <feed> [batchId] --note "why"` (no batchId acts on the current batch; `--list` shows the batches of the feed). Quarantine does NOT reactivate the previous batch on its own — the earlier rows are `superseded`, so the feed is left with no current batch and the vendor scripts fail loudly instead of reading condemned data. To recover, re-upload a good file (identical bytes reuse the stored object, so re-committing the previous version is cheap), then run `npm run feed-sync -- <feed>`.
- Prune old versions: `npm run feed-prune` (dry-run) / `npm run feed-prune -- --apply` (see Retention below).

## Retention

The bucket does not keep history forever: the `feed-prune-apply` cron (opt-in `CRON_FEEDS_PRUNE_ENABLED`, default schedule 6:17) keeps the **2 newest versions of each feed file** and deletes the rest. The rule lives in `lib/feeds/retention.js` (pure) and is executed by `scripts/feed-prune.js`, whose default is always a dry-run — deletion requires the explicit `--apply` flag (`npm run feed-prune-apply`). Tune with `FEED_PRUNE_KEEP_VERSIONS` and `FEED_PRUNE_GRACE_HOURS` (or `--keep` / `--grace-hours`).

Protection is computed from the **catalog**, never from object age — `objectKey` is reused across rows (carry-forward and hash dedupe), so a current artifact can point at a months-old object:

- every key referenced by an `available` or `quarantined` row (any feed, including legacy names) is untouchable;
- the ranking keeps the `keepVersions` newest DISTINCT keys per (feed, fileName) over `available|superseded` rows;
- objects newer than the grace window (default 24h) are never deleted — a signed upload exists in the bucket before its commit catalogs it;
- a feed with no `available` row at all is report-only (protects against a diverging catalog);
- only `feeds/<name>/` prefixes for feeds in `config/feeds.js` are eligible: `feeds/_archive/`, legacy prefixes (`quadratec-pricing`, `quadratec-wholesale`), `logs/`, `certs/` and request attachments are never touched.

Rows whose object is deleted are marked `status: purged` (before the delete, so hash dedupe stops offering the dying key). `FeedArtifact` rows are still never deleted.

## Rollout status

The code is dormant until the bucket exists: `feed-sync` warns and keeps local files while `DO_SPACES_*` is absent or the catalog is empty, so nothing breaks. To activate: provision the Spaces bucket, fill `DO_SPACES_*` in `.env.production`, create `/var/lib/justjeeps-api/feed-cache` on the droplet, backfill artifacts (`feed-fetch-keystone` + `feed-upload` for the manual feeds, `--archive` for orphans), deploy, then set `CRON_FEED_FETCH_KEYSTONE_ENABLED=true`. After one green seed-all cycle the feed files can leave git and the docker image (cleanup phase).
