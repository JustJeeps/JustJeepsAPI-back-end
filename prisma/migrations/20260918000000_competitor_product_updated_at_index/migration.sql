-- DD-018 Lowriders ingest: row freshness for the gated stale delete, and the
-- two lookups the competitor seeds make (by product, and by competitor + sku).
ALTER TABLE "CompetitorProduct"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "CompetitorProduct_product_sku_idx"
  ON "CompetitorProduct"("product_sku");

CREATE INDEX "CompetitorProduct_competitor_id_competitor_sku_idx"
  ON "CompetitorProduct"("competitor_id", "competitor_sku");
