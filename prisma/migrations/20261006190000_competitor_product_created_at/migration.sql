-- When a competitor row first appeared. The column did not exist before, so
-- every row already in the table gets 2026-10-05 as a reference date (the day
-- before the first in-house TDOT run). Noon UTC reads as Oct 5 in Toronto too.
-- A constant default is a metadata-only change: no table rewrite.
ALTER TABLE "CompetitorProduct"
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT '2026-10-05 12:00:00';

-- New rows get the insert time; the seeds' raw INSERTs never name this column.
ALTER TABLE "CompetitorProduct"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;
