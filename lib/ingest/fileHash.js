const fs = require("fs");
const crypto = require("crypto");

// SHA-256 em streaming (nunca carrega o arquivo inteiro) + metadados p/ o
// gate skip-if-unchanged do IngestRun.

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

// Hash combinado de varios arquivos (feeds com mais de um CSV): estavel na
// ordem passada.
async function hashFiles(absPaths) {
  const hash = crypto.createHash("sha256");
  for (const p of absPaths) {
    hash.update(p);
    hash.update(await hashFile(p));
  }
  return hash.digest("hex");
}

module.exports = { hashFile, hashFiles, fileMeta };
