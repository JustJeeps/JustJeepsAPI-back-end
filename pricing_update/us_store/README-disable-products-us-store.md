# US Store Product Disable Script

This folder contains a script to disable products on the **US Magento store view** by setting product `status = 2`.

- Script: `pricing_update/us_store/disable-products-us-store.js`
- Magento endpoint used: `https://www.justjeeps.com/rest/us_sv/V1/products/{sku}`
- NPM command: `npm run disable-products-us-store`

## What it does

1. Reads SKUs from the local database (`Product` table)
2. Filters SKUs using one of these criteria:
   - `jj_prefix` mode
   - exact `vendors` mode (`vendors` field must match exactly)
3. Sends Magento API update request per SKU:
   - Payload: `{ "product": { "status": 2 } }`
4. Prints success/failure summary

---

## Prerequisites

Run inside:
`/Users/tessfbs/justJeepsAPI/JustJeepsAPI-back-end`

Required env vars:
- `MAGENTO_KEY` (required)
- `M2_BASE_URL` (optional, default: `https://www.justjeeps.com/rest/us_sv/V1`)
- `MAGENTO_TIMEOUT_MS` (optional, default: `10000`)

---

## Basic usage

### Help

```bash
npm run disable-products-us-store -- --help
```

### Dry run first (recommended)


```bash
npm run disable-products-us-store -- --dry-run --jj-prefix AEV --limit 20
```

This only shows sample SKUs and does not update Magento.

### Live run by `jj_prefix`

```bash
npm run disable-products-us-store -- --jj-prefix AEV
```

---

## Filter mode 1: `jj_prefix`

Use this when you want all products with a specific `Product.jj_prefix`.

```bash
npm run disable-products-us-store -- --jj-prefix AEV
```

Aliases:
- `--prefix AEV`
- `--vendor AEV` (backward-compatible alias)

---

## Filter mode 2: exact `vendors` value

Use this when you need products where `Product.vendors` is **exactly** one value.

```bash
npm run disable-products-us-store -- --vendors-only "Tire Discounter"
```

Important:
- This is an exact match (case-insensitive, trimmed).
- It does **not** match comma-separated values like:
  - `"Meyer, Tire Discounter, Quadratec"`

Example:

```bash
npm run disable-products-us-store -- --vendors-only "WheelPros (don't DS to US)" --concurrency 30
```

---

## Useful options

- `--status <number>` default `2` (disable)
- `--concurrency <number>` default `10`
- `--limit <number>` limit how many SKUs are processed
- `--dry-run` no Magento updates

Examples:

```bash
# Disable first 50 matching SKUs only
npm run disable-products-us-store -- --jj-prefix AEV --limit 50

# Faster run for large batches
npm run disable-products-us-store -- --vendors-only "WheelPros (don't DS to US)" --concurrency 30
```

---

## Safety checklist (recommended)

1. Start with `--dry-run`
2. Run a small live sample with `--limit`
3. Validate in Magento US store view (`us_sv`)
4. Run full batch

---

## Expected output

You will see:
- Filter used
- Brands found (for `--vendors-only` mode)
- Total SKUs
- Chunk progress
- Final success/failure summary

If failures occur, the script prints the first failed SKUs with error details.
