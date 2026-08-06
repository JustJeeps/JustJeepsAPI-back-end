const path = require('path');

// Project root (where package.json, config/, prisma/ and logs/ live).
//
// Modules extracted into lib/** MUST resolve file paths and the spawn `cwd`
// against this ROOT, NEVER against `__dirname`, which inside lib/** becomes the
// module directory and would silently break:
//   - the seed spawns (`cwd` without package.json, so `npm run` fails)
//   - reading and writing the seed-all logs and summary
//   - the `require(path.join(ROOT, 'package.json'))` used by the cron validation
//
// Before Phase 4a these resolutions used the `__dirname` of server.js (== root),
// so the behavior is identical as long as this ROOT points to the root.
const ROOT = path.resolve(__dirname, '..');

module.exports = { ROOT };
