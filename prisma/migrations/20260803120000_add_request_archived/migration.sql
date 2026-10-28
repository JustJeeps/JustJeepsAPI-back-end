-- AlterTable
ALTER TABLE "Request" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Request_archivedAt_idx" ON "Request"("archivedAt");
