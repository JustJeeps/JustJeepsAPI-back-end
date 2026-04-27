# CAD Store Quadratec Price Update Script

This folder contains a script to update Quadratec product base prices for the CAD store.

- Script: `pricing_update/cad_store/update-quadratec-only-prices-cad-store.js`
- Magento endpoint used: `https://www.justjeeps.com/rest/default/V1/products/base-prices`
- NPM command: `npm run update-quadratec-cad-store-prices`
- Magento store id used in payload: `1`

## What it does

1. Reads products from local database (`Product` table)
2. Filters products by exact vendor match in `Product.vendors` (default `Quadratec`)
3. Reads Quadratec vendor pricing data from `vendorProducts` (`vendor_id = 4`)
4. Calculates CAD store price with the rules below
5. Sends batched updates to Magento `/products/base-prices`
6. Prints success/failure summary and margin statistics
7. Reports changed vs unchanged SKUs and skips unchanged price rows from updates
8. Uses current Magento SKU price as the change baseline (not local DB cached price)

---

## Pricing rules

Base formula:

- USD cost is used only to select the markup tier:
  - If `vendor_cost_usd < 100` use `65%`
  - If `vendor_cost_usd >= 100` use `50%`
- Markup is applied on CAD cost (`vendor_cost`):
  - `price = round((vendor_cost * tier_multiplier) / 0.85, 0) - 0.05`

Then apply floors:

- Minimum final margin floor: `20%`
- Absolute minimum sell price: `11.95`

Margin check used by script (using CAD cost):

`((price * 0.85) - cost) / cost`

---

## Prerequisites

Run inside:
`/Users/tessfbs/justJeepsAPI/JustJeepsAPI-back-end`

Required env vars:

- `MAGENTO_KEY` (required for live runs)
- `M2_BASE_URL_DEFAULT` (optional, default: `https://www.justjeeps.com/rest/default/V1`)
- `MAGENTO_TIMEOUT_MS` (optional, default: `15000`)

---

## Basic usage

### Help

```bash
npm run update-quadratec-cad-store-prices -- --help
```

### Dry run first (recommended)

```bash
npm run update-quadratec-cad-store-prices -- --dry-run --limit 20
```

This prints sample SKUs and calculated prices only. No Magento updates are sent.

### Live run

```bash
npm run update-quadratec-cad-store-prices
```

---

## Useful options

- `--vendor <name>` default `quadratec`
- `--limit <number>` limit products fetched from DB
- `--batch-size <number>` default `1000`
- `--delay-ms <number>` default `400`
- `--dry-run` no Magento updates

Examples:

```bash
# Dry run with larger sample
npm run update-quadratec-cad-store-prices -- --dry-run --limit 100

# Live run with smaller batches
npm run update-quadratec-cad-store-prices -- --batch-size 500 --delay-ms 500
```

---

## Safety checklist (recommended)

1. Run with `--dry-run`
2. Run a small live sample with `--limit`
3. Validate random SKUs in Magento
4. Run full batch

---

## Expected output

You will see:

- Total products scanned
- Total price rows computed
- Changed rows (eligible for update)
- Unchanged rows (skipped)
- Skip counters (mismatch/missing cost/invalid price)
- Cost bucket counts (`< 100` and `>= 100`)
- Margin and min-price floor application counts
- Batch success/failure summary
- Sample updated SKUs
