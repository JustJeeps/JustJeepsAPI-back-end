# Product Reviews Import (Magento)

Spreadsheets with product reviews (columns `sku, email, nickname, rating, title, detail, date, status`) are uploaded in Settings > Reviews and pushed to the store's Magento REST API in batches. The Magento endpoints were built by the store dev and their idempotency is unknown, so **all dedup and resume control lives on our side**.

## Access

Allowlist `REVIEWS_ALLOWED_USERS` (default `ricardo,admin,rafael,tess`). Outside the allowlist the API answers 409 `REVIEWS_RESTRICTED` (never 403: the frontend interceptor logs the user out on auth 403s) and the tab shows Restricted. `GET /api/reviews/meta` stays outside the gate so the frontend can decide whether to show the panel.

## Endpoints (ours)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/reviews/meta` | `{ enabled, batchSize, batchDelayMs, maxUploadBytes, allowedExtensions }` — derived values only, never raw env |
| GET | `/api/reviews/files` | Files with per-status row counts, error samples (up to 10 when there are failures), invalid sample from parse, last sync run (with `startedBy`) and `running` flag |
| POST | `/api/reviews/files` | Upload (multipart field `file`, .xlsx/.csv, max 10MB). Parses, validates and stores rows. 409 `DUPLICATE_FILE` for a file already imported (sha256 unique); re-upload of a file that died mid-import resumes it |
| POST | `/api/reviews/files/:id/sync` | Starts the sync (202 `{ runId }`). 409 `SYNC_ALREADY_RUNNING` if one is in flight |
| POST | `/api/reviews/files/:id/retry-failed` | Requeues `failed` rows as `pending` |

Run history: `GET /api/ingest/runs?feed=magento-reviews` (hidden from users outside the reviews allowlist).

## Magento endpoints (store dev)

- `GET {base}/rest/default/V1/products/{sku}/reviews` — verification (Bearer `MAGENTO_KEY`).
- `POST {base}/rest/default/V1/products/reviews/bulk` — `{ reviews: [{ sku, nickname, summary, text, rating_value, created_at }] }`, recommended max 100 per call.

Column mapping: `title -> summary`, `detail -> text`, `rating -> rating_value`, `date -> created_at` (the sheet has no time, we send `12:00:00`). The `email` and `status` columns are discarded at parse on purpose (no API field, PII minimization).

**A 2xx from the bulk POST is treated as "the whole batch is synced".** The response body is not documented; per-item failures are invisible to us. The safety net is the verification GET plus manual spot checks by SKU.

## Row state machine

`pending -> sending -> synced | failed`. `failed -> pending` only by explicit retry. Rows that fail validation at parse never become rows; they are counted and sampled on the file (`invalidRowCount`, `invalidSample`).

- Batches are write-ahead: rows are committed as `sending` (with `syncRunId`) **before** the POST. `pending` means "certainly not sent"; `sending` means "outcome unknown".
- **No automatic retry on an ambiguous outcome** (timeout, 5xx, dropped socket): the rows stay `sending`, the run ends `failed` and stops. Automatic retry only for 429 and connection refused (the request never reached the server).
- A known 4xx marks the batch `failed` (error code on each row) and the loop continues with the next batch.
- `REVIEWS_SYNC_BATCH_DELAY_MS` sleeps between batches to protect the store.

## Recovery (resume after a crash or deploy)

Every sync run starts with a global recovery phase before sending anything: for each SKU with `sending` rows (any file), it calls the verification GET and matches by nickname + summary + date.

- Matched: the row becomes `synced` (it did land in Magento).
- Verifiably absent: the row goes back to `pending` and is resent safely.
- GET failed or the response shape is unreadable: **nothing is sent**, the run ends `failed` with `RECOVERY_BLOCKED`, and the next run retries the verification. Absence is never assumed.

One sync at a time via a cross-process lease lock (60min lease; a 25k-row file at batch 50 takes ~20-25min). If the process dies, the lease expires on its own, `closeStaleRuns` closes the orphan run at boot, and the next sync recovers the `sending` rows.

Manual escape hatch when the verification GET is broken: `npm run reviews-sync -- --file <id> --mark-sending-failed`, **only after checking in the Magento admin that those reviews are not there**.

## Dedup guarantees

- File level: `ReviewImportFile.sha256` unique — the same file never enters twice (409).
- Row level: `ReviewImportRow.rowHash` unique and **global** — the same review appearing in two different spreadsheets is only sent once (skipped rows are counted as `duplicateRowCount` on the file).
- The database constraints decide (concurrent uploads race-safe); code checks exist only for friendly messages.

## CLI

```bash
npm run reviews-sync                          # dry-run: files and pending counts
npm run reviews-sync -- --file 3 --apply       # sync file 3 (writes to PRODUCTION)
npm run reviews-sync -- --file 3 --retry-failed --apply
npm run reviews-sync -- --file 3 --mark-sending-failed
```

## Env

| Env | Default | Meaning |
|---|---|---|
| `REVIEWS_ALLOWED_USERS` | `ricardo,admin,rafael,tess` | Who sees/operates the tab |
| `REVIEWS_SYNC_BATCH_SIZE` | 50 (clamped 1..100) | Reviews per bulk POST |
| `REVIEWS_SYNC_BATCH_DELAY_MS` | 1000 (min 500) | Pause between batches |
| `REVIEWS_MAX_UPLOAD_BYTES` | 10MB | Upload cap (spreadsheet parse runs in memory) |
| `REVIEWS_MAX_ROWS` | 60000 | Row ceiling (anti XLSX bomb, enforced with `sheetRows`) |
| `MAGENTO_REVIEWS_KEY` | unset | Optional dedicated token with the `JWA_ProductReviewApi` ACL; falls back to `MAGENTO_KEY` |
| `MAGENTO_KEY` / `MAGENTO_BASE_URL` / `MAGENTO_TIMEOUT_MS` | existing | Magento client (reviews default base is `https://justjeeps.com`, no www: the www host answers a Sucuri 307) |

## Production notes (smoke test 2026-08-25)

- The store sits behind the Sucuri WAF: Magento API calls only work from the production droplet IP. Local machines get a 307 challenge, so panel/CLI syncs must run in production.
- The verification GET returns `{ sku, rating_summary, review_count, reviews: [...] }`; the client unwraps `reviews`.
- The current `MAGENTO_KEY` integration token is NOT authorized for `JWA_ProductReviewApi::bulk_create` (HTTP 401). The store dev has to grant that ACL resource to the integration, or issue a dedicated token (then set `MAGENTO_REVIEWS_KEY`).

## Evolution notes

- Rows keep names/nicknames indefinitely for audit. If PII retention becomes a concern, purge the payload of old `synced` rows and keep hash + status + timestamps (dedup keeps working by hash).
- No delete endpoint on purpose: deleting rows would delete the hashes and a re-upload would resend everything to the store.
