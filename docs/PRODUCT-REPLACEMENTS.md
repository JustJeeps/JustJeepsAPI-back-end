# Product Replacements (SKU substitutions)

One place to register that a product can be replaced by another one, and a shortcut to consult that from the Orders screen. Until now this knowledge lived in emails, spreadsheets and people's heads. The feature is decision support only: registering or consulting a replacement never changes an order, a PO, a unit cost or Magento.

Frontend lives in `JustJeepsAPI-front-end/src/features/replacements/` (management screen at `/replacements`, lookup drawer inside `/orders`). Backend code map:

| Layer | File |
|---|---|
| Routes (HTTP only) | `routes/productReplacements.js` |
| Service (use cases, data access, injectable) | `services/productReplacements/productReplacementsService.js`, `services/productReplacements/errors.js` |
| Domain rules (pure, tested) | `lib/productReplacements/rules.js` |
| Product projection shared with the magnifier lookup | `lib/products/productLookupSelect.js` (also used by `GET /api/products/:sku` in `server.js`) |
| Live product info from Magento (name, image, description, page) | `lib/magento/productInfoClient.js` (read only, cached, falls back to the `Product` table) |
| Constants and allowlist | `config/productReplacements.js` (`REPLACEMENTS_MANAGER_USERS`) |
| DB models | `prisma/schema.prisma`: `ProductReplacement`, `ProductReplacementComment` (migration `20260924100000_add_product_replacements`) |

## Product cards: live from Magento, catalog as fallback

Image, name, description and the store page link shown on every product card (directory, creation modal, lookup drawer) come from the live Magento REST API (`GET /rest/default/V1/products?searchCriteria[...]` with an `in` filter on `sku`, batches of 50, three requests in flight, 5 s per request, answers cached in memory for 10 minutes; all tunable through `MAGENTO_PRODUCT_INFO_*` in `.env.example`). The description is `short_description` (else `description`) with the HTML stripped, capped at 600 characters. Price, vendor costs, competitors and inventory always come from the catalog table, so the lookup drawer shows the same numbers as the magnifier.

When the store does not answer, the client never throws: the screen falls back to the `Product` table and the response carries `magento: { configured, degraded }` so the page and the drawer show "Showing catalog data". Rules of the client (`lib/magento/productInfoClient.js`):

- A 200 whose body is not a product list (WAF or maintenance page, a token without the ACL) is a failure (`MAGENTO_UNEXPECTED_RESPONSE`, logged with status, content type and the first 200 chars of the body), never "these SKUs do not exist"; nothing is cached for it.
- After any failure a 60 s cooldown stops every caller from paying the timeout again; opening and closing are logged once.
- HTTP failures are logged at warn level without the token; a parser crash is logged at error level with its stack, so a payload change is never mistaken for an outage.
- A SKU that Magento does not return is remembered as unknown for the cache TTL. A SKU that Magento knows but the catalog table does not gets a card only in the creation modal preview; in the directory and in the lookup drawer it is `product: null` (the drawer's `ProductTable` needs the catalog's vendor and competitor data).
- `createDefaultRouter` warns at startup when `MAGENTO_KEY` is unset.

## Data model

- An association is `source_sku -> replacement_sku`, directional (A -> B does not imply B -> A). One source can have many replacements; each pair is its own row with its own comments, creator and date/time.
- SKUs are stored as plain strings, with no foreign key to `Product`. The catalog is rewritten by the seeds and `prisma/seeds/deleteEntries.js` drops products by prefix; a foreign key would either cascade-delete the directory or break those scripts. Both SKUs are validated against `Product` when the association is created and the product data is resolved at read time (a product that left the catalog shows as `product: null`).
- Removing an association or a comment is a soft delete (`deletedAt`, `deletedById`). Removed rows disappear from every screen; nothing is erased.
- The same active pair cannot exist twice. The database enforces it with a partial unique index (`ProductReplacement_active_pair_key` on `source_sku, replacement_sku` where `deletedAt IS NULL`); the service checks first and maps the `P2002` race to 409 `DUPLICATE_REPLACEMENT`. A removed pair can be registered again.
- A SKU cannot replace itself (`SELF_REPLACEMENT`).

## "No replacement" marker

A product can be registered as having NO replacement: a `ProductReplacement` row with `kind = 'none'` and `replacement_sku = null`, whose first comment (required) explains why. Rules:

- The comment is required (`COMMENT_REQUIRED`, 400).
- A marker and replacements never coexist for the same product: marking a product that has active replacements answers 409 `HAS_REPLACEMENTS`; registering a replacement for a marked product answers 409 `MARKED_NO_REPLACEMENT`; a second marker answers 409 `NO_REPLACEMENT_EXISTS` (also enforced by the partial unique index `ProductReplacement_active_none_key`). Nothing is removed automatically: remove the other side first.
- Removing a marker is a soft delete like any association (creator or manager).
- On the Orders screen a marked SKU shows a red stop icon instead of the swap icon; it opens nothing, its tooltip is the comment plus who registered it and when. `GET /counts` carries that text.

## API

All routes require a logged in user (`ENABLE_AUTH=true`) inside the rollout gate (see Permissions); the user is the author of every write, and the date and time are recorded by the database. Business rule violations return **409 with a `code`**, never 403 (the frontend interceptor logs the user out on auth 403). Unknown SKUs are 400 `SKU_NOT_FOUND`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/product-replacements/meta` | `{ enabled, isManager, managers }`: `enabled` is the rollout gate for the caller (the frontend hides the feature when false), `isManager` lets it hide the Remove buttons; the backend enforces both anyway. This is the only route outside the gate |
| GET | `/api/product-replacements/products/:sku` | Product preview for the creation modal: `{ sku, name, description, image, url_path, price, brand_name, status, source }`; 404 `SKU_NOT_FOUND` when neither the catalog nor Magento knows it |
| GET | `/api/product-replacements?search=` | Directory grouped by original product: `{ groups: [{ source_sku, sourceProduct, replacements: [{ id, replacement_sku, product, createdAt, createdBy, comments }] }], total, truncated, magento }`. The newest 500 active associations are loaded; `search` (max 100 chars) filters them in memory by source SKU, replacement SKU and the product names shown on the cards; `total` is the number of matches (all active associations without a search) and `truncated` says the cap was hit |
| POST | `/api/product-replacements` | Create a batch: `{ source_sku, replacements: [{ replacement_sku, comment? }] }` (max 20 per call), or a marker: `{ source_sku, no_replacement: true, comment }`. Answers 201 with the created rows (`kind` is `replacement` or `none`). Errors: `SKU_NOT_FOUND`, `COMMENT_REQUIRED` (400), `SELF_REPLACEMENT`, `DUPLICATE_REPLACEMENT`, `HAS_REPLACEMENTS`, `MARKED_NO_REPLACEMENT`, `NO_REPLACEMENT_EXISTS` (409) |
| DELETE | `/api/product-replacements/:id` | Soft delete. Creator or manager only (409 `NOT_ALLOWED`) |
| POST | `/api/product-replacements/:id/comments` | Add a comment `{ body }` (max 2000 chars). Answers 201 with the comment and its author |
| DELETE | `/api/product-replacements/:id/comments/:commentId` | Soft delete a comment. Author or manager only |
| GET | `/api/product-replacements/for-sku/:sku` | Replacement Lookup: `{ source_sku, sourceProduct, replacements: [...], noReplacement: { id, comment, createdBy, createdAt } \| null, magento }` (markers never appear among `replacements`) where each `product` uses the same projection as the magnifier lookup (`PRODUCT_LOOKUP_SELECT`), so the drawer shows the same vendor costs, competitors and inventory; `product` is `null` when the SKU is not in the catalog table |
| GET | `/api/product-replacements/counts?skus=A,B` | `{ counts: { A: { replacements: 2, noReplacement: null }, B: { replacements: 0, noReplacement: { comment, by, at } } } }` for the expanded order rows (max 200 SKUs; missing key = nothing registered) |

Comments are never edited: new guidance is a new comment, and an outdated one can be removed.

## Permissions

- Rollout gate: while the team tests the feature, only the users in `REPLACEMENTS_ALLOWED_USERS` (default `admin,ricardo,paula,karoline`, set in `config/deploy.yml`) see and use it. For everyone else the navbar item, the Orders icon and the page are hidden, `GET /meta` answers `enabled: false` and every other route answers 409 `REPLACEMENTS_RESTRICTED`. The list matches the username or the local part of the e-mail. Release = widen the list.
- Inside the gate, any user can register replacements and add comments.
- Removing an association or a comment: the person who created it, or a manager from `REPLACEMENTS_MANAGER_USERS` (default and `config/deploy.yml`: `ricardo,admin,tess,paula`).

## Tests

`npm test` (no database, no network):

- `test/lib/productReplacements/rules.test.js`: pure rules (self replacement, removal permissions, grouping).
- `test/lib/productReplacements/productReplacementsService.test.js`: the service against an in-memory prisma stub (create, duplicates including the P2002 race, unknown SKUs, soft delete, comments, lookup direction, counts, search, Magento merge and catalog fallback).
- `test/lib/magento/productInfoClient.test.js`: the Magento client with a fake http (parsing, one call per batch, concurrency, cache ttl and cap, unknown SKUs remembered, unexpected 200 body, parser crash, cooldown, failure without token in the log).
- `test/routes/productReplacements.test.js` also covers the 100-char search cap and the product preview route.
- `test/routes/productReplacements.test.js`: real HTTP through the router with a fake service (401 guard, payload shape, id parsing, 409 code mapping, 500 fallback).
