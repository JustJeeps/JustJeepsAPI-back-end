-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "updated_at" SET DEFAULT now()::text;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "contentHash" TEXT;

-- AlterTable
ALTER TABLE "VendorProduct" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "lastPushedAt" TIMESTAMP(3),
ADD COLUMN     "lastPushedHash" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" SERIAL NOT NULL,
    "feed" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "sourceKind" TEXT,
    "sourceRef" TEXT,
    "sourceHash" TEXT,
    "sourceMtime" TIMESTAMP(3),
    "sourceRowCount" INTEGER,
    "rowsInserted" INTEGER NOT NULL DEFAULT 0,
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsMarkedStale" INTEGER NOT NULL DEFAULT 0,
    "rowsDeleted" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "watermarkFrom" TEXT,
    "watermarkTo" TEXT,
    "error" TEXT,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestRun_feed_startedAt_idx" ON "IngestRun"("feed", "startedAt");

-- CreateIndex
CREATE INDEX "IngestRun_feed_status_idx" ON "IngestRun"("feed", "status");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX "VendorProduct_product_sku_idx" ON "VendorProduct"("product_sku");

-- Dedup defensivo de (vendor_id, vendor_sku) ANTES do indice unico: reatribui
-- referencias de OrderProduct para a linha mantida (maior id) e apaga as
-- demais. IMPORTANTANTE: sem a reatribuicao, o DELETE cascatearia OrderProducts
-- (FK onDelete: Cascade). No-op quando nao ha duplicatas (prod verificado em
-- 20/jul/2026: zero grupos).
WITH keepers AS (
  SELECT max(id) AS keep_id, vendor_id, vendor_sku
  FROM "VendorProduct" GROUP BY vendor_id, vendor_sku HAVING count(*) > 1
),
dupes AS (
  SELECT vp.id AS dupe_id, k.keep_id
  FROM "VendorProduct" vp
  JOIN keepers k ON k.vendor_id = vp.vendor_id AND k.vendor_sku = vp.vendor_sku
  WHERE vp.id <> k.keep_id
),
reassign AS (
  UPDATE "OrderProduct" op SET vendor_product_id = d.keep_id
  FROM dupes d WHERE op.vendor_product_id = d.dupe_id
  RETURNING op.id
)
DELETE FROM "VendorProduct" WHERE id IN (SELECT dupe_id FROM dupes);

-- CreateIndex
CREATE UNIQUE INDEX "VendorProduct_vendor_id_vendor_sku_key" ON "VendorProduct"("vendor_id", "vendor_sku");
