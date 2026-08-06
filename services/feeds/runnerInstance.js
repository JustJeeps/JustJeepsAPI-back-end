// Single instance of the feed runner, shared between the route that triggers
// "Run now" (routes/ingest.js) and the command cron scheduler (server.js).
//
// It has to be the SAME instance on both sides: the runner refuses to start
// during seed-all (lock file) and server.js refuses to start a command cron
// while a manual run is active (isBusy). Two instances would leave that pair
// of locks blind on one side and two seeds of the same vendor would run
// together over the same staging table.

const prisma = require('../../lib/prisma');
const { createFeedRunner } = require('../../lib/feeds/feedRunner');

// prisma goes in so a run started from the panel leaves a trace even when the
// vendor script does not record one itself.
module.exports = createFeedRunner({ prisma });
