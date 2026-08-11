-- Setores (boards por setor): Sector, SectorMember, TrelloSectorBoard,
-- SectorActivity + Request.sector_id. Seed do setor General, backfill de todos
-- os chamados existentes e seed dos usuarios de triage como admins do General
-- (dia um nao pode ser admin-less — guard LAST_ADMIN em lib/sectors/membership.js).

-- CreateTable
CREATE TABLE "Sector" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SectorMember" (
    "id" SERIAL NOT NULL,
    "sector_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SectorMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrelloSectorBoard" (
    "id" SERIAL NOT NULL,
    "sectorId" INTEGER NOT NULL,
    "boardId" TEXT NOT NULL,
    "boardName" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "listName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrelloSectorBoard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SectorActivity" (
    "id" SERIAL NOT NULL,
    "sector_id" INTEGER NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SectorActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sector_slug_key" ON "Sector"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SectorMember_sector_id_user_id_key" ON "SectorMember"("sector_id", "user_id");

-- CreateIndex
CREATE INDEX "SectorMember_user_id_idx" ON "SectorMember"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "TrelloSectorBoard_sectorId_key" ON "TrelloSectorBoard"("sectorId");

-- CreateIndex
CREATE INDEX "SectorActivity_sector_id_idx" ON "SectorActivity"("sector_id");

-- CreateIndex
CREATE INDEX "SectorActivity_createdAt_idx" ON "SectorActivity"("createdAt");

-- AddForeignKey
ALTER TABLE "SectorMember" ADD CONSTRAINT "SectorMember_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "Sector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SectorMember" ADD CONSTRAINT "SectorMember_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrelloSectorBoard" ADD CONSTRAINT "TrelloSectorBoard_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SectorActivity" ADD CONSTRAINT "SectorActivity_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "Sector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SectorActivity" ADD CONSTRAINT "SectorActivity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed: setor default (General) — destino de chamados sem setor no payload
INSERT INTO "Sector" ("name", "slug") VALUES ('General', 'general');

-- Request.sector_id: adiciona nullable, backfill de TODAS as rows (inclusive
-- arquivadas/deletadas) para o General, e so entao trava NOT NULL + FK.
ALTER TABLE "Request" ADD COLUMN "sector_id" INTEGER;

UPDATE "Request" SET "sector_id" = (SELECT "id" FROM "Sector" WHERE "slug" = 'general');

ALTER TABLE "Request" ALTER COLUMN "sector_id" SET NOT NULL;

-- AddForeignKey (RESTRICT: setor com chamados nunca e deletado)
ALTER TABLE "Request" ADD CONSTRAINT "Request_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Request_sector_id_idx" ON "Request"("sector_id");

-- Seed: usuarios de triage viram admins do General (mesmo default de
-- REQUESTS_TRIAGE_USERS em config/requests.js)
INSERT INTO "SectorMember" ("sector_id", "user_id", "role")
SELECT s."id", u."id", 'admin'
FROM "Sector" s, "User" u
WHERE s."slug" = 'general' AND LOWER(u."username") IN ('ricardo', 'admin', 'tess')
ON CONFLICT ("sector_id", "user_id") DO NOTHING;
