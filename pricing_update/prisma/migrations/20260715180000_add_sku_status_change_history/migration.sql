-- CreateTable
CREATE TABLE "SkuStatusChangeHistory" (
    "id" SERIAL NOT NULL,
    "recordKey" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportDate" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changedByName" TEXT NOT NULL,
    "changedByEmail" TEXT,
    "source" TEXT NOT NULL,
    "requestedSku" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "status" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "applyToChildren" BOOLEAN NOT NULL DEFAULT false,
    "updatedStoreViews" JSONB,
    "failedStoreViews" JSONB,

    CONSTRAINT "SkuStatusChangeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuStatusChangeHistory_recordKey_key" ON "SkuStatusChangeHistory"("recordKey");

-- CreateIndex
CREATE INDEX "SkuStatusChangeHistory_reportDate_idx" ON "SkuStatusChangeHistory"("reportDate");

-- CreateIndex
CREATE INDEX "SkuStatusChangeHistory_recordedAt_idx" ON "SkuStatusChangeHistory"("recordedAt");

-- CreateIndex
CREATE INDEX "SkuStatusChangeHistory_changedBy_idx" ON "SkuStatusChangeHistory"("changedBy");

-- CreateIndex
CREATE INDEX "SkuStatusChangeHistory_sku_idx" ON "SkuStatusChangeHistory"("sku");
