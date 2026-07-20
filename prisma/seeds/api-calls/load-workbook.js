const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

// Logs which data file is being loaded, its mtime and size, and warns when
// the file looks stale — lets each seed run confirm it used today's feed.
function logFileFreshness(filePath) {
  const stats = fs.statSync(filePath);
  const ageHours = (Date.now() - stats.mtimeMs) / 36e5;
  const sizeMb = (stats.size / 1048576).toFixed(1);
  console.log(
    `📄 Loading ${path.basename(filePath)} (modified ${stats.mtime.toISOString()}, ${sizeMb} MB, ~${ageHours.toFixed(1)}h old)`
  );
  if (ageHours > 24) {
    console.warn(
      `⚠️  ${path.basename(filePath)} is older than 24h — may not be today's feed`
    );
  }
}

// Resolves "<baseName>.csv" (preferred) or "<baseName>.xlsx" in this directory
// and returns the parsed workbook. CSV is read with raw:true so part numbers
// keep leading zeros and never get coerced into numbers or dates.
function loadWorkbook(baseName) {
  const csvPath = path.join(__dirname, `${baseName}.csv`);
  if (fs.existsSync(csvPath)) {
    logFileFreshness(csvPath);
    return XLSX.readFile(csvPath, { raw: true });
  }

  const xlsxPath = path.join(__dirname, `${baseName}.xlsx`);
  if (fs.existsSync(xlsxPath)) {
    logFileFreshness(xlsxPath);
    return XLSX.readFile(xlsxPath);
  }

  throw new Error(
    `Missing data file: expected ${baseName}.csv or ${baseName}.xlsx in ${__dirname}`
  );
}

module.exports = loadWorkbook;
