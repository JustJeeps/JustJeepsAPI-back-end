-- Import de reviews de produtos para o Magento (docs/REVIEWS-IMPORT.md).
-- Migration ADITIVA: duas tabelas novas + uma coluna nullable no IngestRun.
-- Nenhuma tabela/coluna existente muda de forma destrutiva. Aplicada em
-- producao pelo `npx prisma migrate deploy` do docker-entrypoint.sh.
--
-- ReviewImportFile.sha256 UNIQUE = "o mesmo arquivo nunca entra 2x";
-- ReviewImportRow.rowHash UNIQUE (global) = a mesma avaliacao presente em
-- duas planilhas so e enviada uma vez ao Magento. As constraints decidem o
-- dedup (corrida de uploads simultaneos fecha no banco, nao em check-then-insert).

-- CreateTable
CREATE TABLE "ReviewImportFile" (
    "id" SERIAL NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'importing',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateRowCount" INTEGER NOT NULL DEFAULT 0,
    "invalidRowCount" INTEGER NOT NULL DEFAULT 0,
    "invalidSample" JSONB,
    "objectKey" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "ReviewImportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewImportRow" (
    "id" SERIAL NOT NULL,
    "fileId" INTEGER NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ratingValue" INTEGER NOT NULL,
    "reviewDate" TEXT NOT NULL,
    "rowHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "syncedAt" TIMESTAMP(3),
    "syncRunId" INTEGER,

    CONSTRAINT "ReviewImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewImportFile_sha256_key" ON "ReviewImportFile"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewImportRow_rowHash_key" ON "ReviewImportRow"("rowHash");

-- CreateIndex
CREATE INDEX "ReviewImportRow_fileId_status_idx" ON "ReviewImportRow"("fileId", "status");

-- CreateIndex
CREATE INDEX "ReviewImportRow_status_id_idx" ON "ReviewImportRow"("status", "id");

-- AddForeignKey
ALTER TABLE "ReviewImportRow" ADD CONSTRAINT "ReviewImportRow_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ReviewImportFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: quem disparou o run (painel/CLI); null = cron. Beneficia todos
-- os feeds, nao so o magento-reviews.
ALTER TABLE "IngestRun" ADD COLUMN "startedBy" TEXT;
