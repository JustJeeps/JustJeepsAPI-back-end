-- AlterTable
ALTER TABLE "Request" ADD COLUMN "deletedAt" TIMESTAMP(3),
                      ADD COLUMN "deletedById" INTEGER;

-- CreateIndex
CREATE INDEX "Request_deletedAt_idx" ON "Request"("deletedAt");
