-- Product Replacement: known SKU substitutions registered by the team and
-- consulted from the Orders screen (docs/PRODUCT-REPLACEMENTS.md).
-- No foreign key to "Product" on purpose: the catalog is rewritten by the
-- seeds and deleteEntries.js drops products by prefix.
CREATE TABLE "ProductReplacement" (
  "id" SERIAL NOT NULL,
  "source_sku" TEXT NOT NULL,
  "replacement_sku" TEXT NOT NULL,
  "created_by_id" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "deletedById" INTEGER,
  CONSTRAINT "ProductReplacement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductReplacement_source_sku_idx" ON "ProductReplacement"("source_sku");
CREATE INDEX "ProductReplacement_replacement_sku_idx" ON "ProductReplacement"("replacement_sku");
CREATE INDEX "ProductReplacement_deletedAt_idx" ON "ProductReplacement"("deletedAt");

-- BR-07: the same active pair only once. A removed (soft deleted) pair can be
-- registered again, so the index only covers active rows.
CREATE UNIQUE INDEX "ProductReplacement_active_pair_key"
  ON "ProductReplacement"("source_sku", "replacement_sku")
  WHERE "deletedAt" IS NULL;

ALTER TABLE "ProductReplacement"
ADD CONSTRAINT "ProductReplacement_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProductReplacementComment" (
  "id" SERIAL NOT NULL,
  "replacement_id" INTEGER NOT NULL,
  "author_id" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "deletedById" INTEGER,
  CONSTRAINT "ProductReplacementComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductReplacementComment_replacement_id_idx" ON "ProductReplacementComment"("replacement_id");

ALTER TABLE "ProductReplacementComment"
ADD CONSTRAINT "ProductReplacementComment_replacement_id_fkey"
FOREIGN KEY ("replacement_id") REFERENCES "ProductReplacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductReplacementComment"
ADD CONSTRAINT "ProductReplacementComment_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
