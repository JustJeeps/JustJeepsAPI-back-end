-- Catalogo de artefatos de feed (landing zone no DO Spaces) + proveniencia
-- arquivo->rodada no IngestRun. Aditiva: nenhuma tabela/coluna existente muda.

CREATE TABLE "FeedArtifact" (
    "id" SERIAL NOT NULL,
    "feed" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "contentType" TEXT,
    "source" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'available',
    "note" TEXT,

    CONSTRAINT "FeedArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedArtifact_objectKey_key" ON "FeedArtifact"("objectKey");

CREATE INDEX "FeedArtifact_feed_fileName_status_uploadedAt_idx"
    ON "FeedArtifact"("feed", "fileName", "status", "uploadedAt");

CREATE INDEX "FeedArtifact_batchId_idx" ON "FeedArtifact"("batchId");

ALTER TABLE "IngestRun" ADD COLUMN "artifactBatchId" TEXT;
