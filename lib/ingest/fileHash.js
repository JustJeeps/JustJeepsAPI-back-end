const fs = require("fs");
const crypto = require("crypto");

// Streaming SHA-256 (never loads the whole file) plus metadata for the
// skip-if-unchanged gate of IngestRun.

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(absPath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function fileMeta(absPath) {
  const stats = fs.statSync(absPath);
  return { mtime: stats.mtime, sizeBytes: stats.size };
}

// Combined hash of several files (feeds with more than one CSV): stable for the
// order in which the paths are passed.
async function hashFiles(absPaths) {
  const hash = crypto.createHash("sha256");
  for (const p of absPaths) {
    hash.update(p);
    hash.update(await hashFile(p));
  }
  return hash.digest("hex");
}

module.exports = { hashFile, hashFiles, fileMeta };
