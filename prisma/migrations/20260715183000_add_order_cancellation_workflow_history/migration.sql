-- CreateTable
CREATE TABLE "OrderCancellationWorkflowHistory" (
    "id" SERIAL NOT NULL,
    "recordKey" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportDate" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL,
    "orderId" INTEGER,
    "incrementId" TEXT,
    "requestedOrderIdentifier" TEXT,
    "orderCancelledInMagento" BOOLEAN NOT NULL DEFAULT false,
    "invoiceVoidDeleteCompleted" BOOLEAN NOT NULL DEFAULT false,
    "cancellationTicketSent" BOOLEAN NOT NULL DEFAULT false,
    "cancellationAttributesUpdated" BOOLEAN NOT NULL DEFAULT false,
    "localStatusUpdated" BOOLEAN NOT NULL DEFAULT false,
    "failedActions" JSONB,
    "completedActions" JSONB,
    "manualActionsStillRequired" JSONB,
    "orderSnapshot" JSONB,

    CONSTRAINT "OrderCancellationWorkflowHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderCancellationWorkflowHistory_recordKey_key" ON "OrderCancellationWorkflowHistory"("recordKey");

-- CreateIndex
CREATE INDEX "OrderCancellationWorkflowHistory_reportDate_idx" ON "OrderCancellationWorkflowHistory"("reportDate");

-- CreateIndex
CREATE INDEX "OrderCancellationWorkflowHistory_recordedAt_idx" ON "OrderCancellationWorkflowHistory"("recordedAt");

-- CreateIndex
CREATE INDEX "OrderCancellationWorkflowHistory_cancelledBy_idx" ON "OrderCancellationWorkflowHistory"("cancelledBy");

-- CreateIndex
CREATE INDEX "OrderCancellationWorkflowHistory_orderId_idx" ON "OrderCancellationWorkflowHistory"("orderId");

-- CreateIndex
CREATE INDEX "OrderCancellationWorkflowHistory_incrementId_idx" ON "OrderCancellationWorkflowHistory"("incrementId");
