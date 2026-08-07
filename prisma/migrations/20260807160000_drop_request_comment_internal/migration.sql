-- The "internal note" flag never did anything: no read path filtered on it, so
-- every comment reached everyone who could open the request, and no
-- notification behaved differently. It promised privacy it did not provide, so
-- the feature was removed rather than relabelled.
--
-- Dropped only after the deploy that stopped reading and writing it, so no
-- running container ever queries a column that is gone.
ALTER TABLE "RequestComment" DROP COLUMN IF EXISTS "internal";
