-- CreateTable
CREATE TABLE "RequestAssignee" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequestAssignee_request_id_user_id_key" ON "RequestAssignee"("request_id", "user_id");

-- CreateIndex
CREATE INDEX "RequestAssignee_user_id_idx" ON "RequestAssignee"("user_id");

-- AddForeignKey
ALTER TABLE "RequestAssignee" ADD CONSTRAINT "RequestAssignee_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestAssignee" ADD CONSTRAINT "RequestAssignee_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: assignee primario existente vira a primeira linha da lista
INSERT INTO "RequestAssignee" ("request_id", "user_id")
SELECT "id", "assignee_id" FROM "Request" WHERE "assignee_id" IS NOT NULL;
