-- An object in the bucket is addressed by its content, so the same object has
-- to be catalogable more than once: when a later batch reuses a file that did
-- not change, a new row points at the object that is already stored. The
-- unique index made every reuse fail with a constraint violation, which the
-- API surfaced as a 500 and the panel worked around by re-uploading the whole
-- file. Dropping it to a plain index restores the intended behaviour.

DROP INDEX IF EXISTS "FeedArtifact_objectKey_key";

CREATE INDEX IF NOT EXISTS "FeedArtifact_objectKey_idx" ON "FeedArtifact"("objectKey");
