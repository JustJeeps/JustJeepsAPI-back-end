-- Vendor and Competitor rows were inserted with explicit ids at some point,
-- so their id sequences fell behind the data (Vendor: sequence 13, max id 17;
-- Competitor: sequence 1, max id 5 on 2026-10-29). The next INSERT without an
-- id then failed with "Unique constraint failed on the fields: (id)", which is
-- what stopped the first JRP apply (IngestRun 1713). Move each sequence to the
-- current max id. Safe to run again: setval never moves a sequence backwards
-- here because the value is always the current max.
SELECT setval(pg_get_serial_sequence('"Vendor"', 'id'), COALESCE((SELECT MAX(id) FROM "Vendor"), 1));
SELECT setval(pg_get_serial_sequence('"Competitor"', 'id'), COALESCE((SELECT MAX(id) FROM "Competitor"), 1));
