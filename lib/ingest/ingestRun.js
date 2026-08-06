const prisma = require("../prisma");
const logger = require("../../utils/logger");

// Provenance per ingestion round + skip-if-unchanged gate based on the source
// hash. One IngestRun row per execution; an ingest_run event in Axiom on close
// (durable: logger.ingestEvent waits for the flush).

async function startRun(feed, { sourceKind, sourceRef, sourceHash, sourceMtime, sourceRowCount, artifactBatchId } = {}) {
  const run = await prisma.ingestRun.create({
    data: { feed, sourceKind, sourceRef, sourceHash, sourceMtime, sourceRowCount, artifactBatchId },
  });

  return {
    id: run.id,
    feed,
    startedAtMs: Date.now(),

    async finish({ status = "success", counts = {}, watermarkFrom, watermarkTo, error, sourceHash: finalHash, sourceRowCount: finalRows } = {}) {
      const durationMs = Date.now() - this.startedAtMs;
      await prisma.ingestRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          status,
          rowsInserted: counts.inserted || 0,
          rowsUpdated: counts.updated || 0,
          rowsMarkedStale: counts.markedStale || 0,
          rowsDeleted: counts.deleted || 0,
          rowsSkipped: counts.skipped || 0,
          watermarkFrom,
          watermarkTo,
          error: error ? String(error).slice(0, 4000) : null,
          ...(finalHash ? { sourceHash: finalHash } : {}),
          ...(Number.isFinite(finalRows) ? { sourceRowCount: finalRows } : {}),
        },
      });

      await logger.ingestEvent({
        type: "ingest_run",
        feed,
        runId: run.id,
        trigger: process.env.INGEST_TRIGGER || "cron",
        outcome: status,
        rowsIn: Number.isFinite(finalRows) ? finalRows : sourceRowCount || 0,
        rowsChanged: (counts.inserted || 0) + (counts.updated || 0),
        rowsSkipped: counts.skipped || 0,
        rowsFailed: status === "failed" ? 1 : 0,
        rowsStale: (counts.markedStale || 0) + (counts.deleted || 0),
        durationMs,
        error: error ? String(error).slice(0, 500) : undefined,
      });

      return durationMs;
    },
  };
}

// true when the last SUCCESSFUL round of this feed processed exactly the same
// source (equal hash), so the current round can become a no-op.
async function isUnchanged(feed, sourceHash) {
  if (!sourceHash) return false;
  const last = await prisma.ingestRun.findFirst({
    where: { feed, status: "success" },
    orderBy: { id: "desc" },
    select: { sourceHash: true },
  });
  return Boolean(last && last.sourceHash && last.sourceHash === sourceHash);
}

module.exports = { startRun, isUnchanged };
