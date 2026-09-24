-- "No replacement" marker: a ProductReplacement row with kind = 'none' and no
-- replacement SKU says the product has no known substitute (the comment
-- explains why). Existing rows keep kind = 'replacement' through the default.
ALTER TABLE "ProductReplacement" ALTER COLUMN "replacement_sku" DROP NOT NULL;
ALTER TABLE "ProductReplacement" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'replacement';

CREATE INDEX "ProductReplacement_kind_idx" ON "ProductReplacement"("kind");

-- One active marker per product. Postgres treats NULL as distinct, so the
-- active-pair index does not cover markers; this partial index does.
CREATE UNIQUE INDEX "ProductReplacement_active_none_key"
  ON "ProductReplacement"("source_sku")
  WHERE "deletedAt" IS NULL AND "kind" = 'none';
