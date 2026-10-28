-- When the file was produced at the SOURCE, as opposed to when it reached us.
--
-- Freshness used to be read from the mtime of the file on disk. Once a feed is
-- served from the bucket that file is a symlink into the download cache, so its
-- mtime is when we fetched it and every snapshot looks brand new. Falling back
-- to the upload time is honest for a file uploaded right after being exported
-- and optimistic for an old file uploaded late, which is exactly the case the
-- QuickBooks staleness alert exists to catch.
ALTER TABLE "FeedArtifact" ADD COLUMN IF NOT EXISTS "sourceModifiedAt" TIMESTAMP(3);
