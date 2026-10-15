const defaultXLSX = require("xlsx");
const defaultFs = require("fs");
const path = require("path");

// Quadratec "gold kit" export (sheet WholesaleKitPricingSheetGoldRe).
//
// Up to Sep 2026 the kits were rows of pricingSheet_quad.xlsx, appended by
// hand below the item rows. Since Oct 2026 Quadratec ships them in this
// separate file. This adapter gives each kit row the exact shape it had in
// the gold sheet, so quadratec-excel.js can treat both sources the same way
// (same brand rules, money parsing, price swap and alt codes).

const KIT_HEADER = ["Name", "Display Name", "Retail Price", "Wholesale Price", "Brand"];

function normalizeText(value) {
  return (value ?? "").toString().trim();
}

function trimIfString(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value.trim() : value;
}

function isNumericPrice(value) {
  if (typeof value === "number") return Number.isFinite(value);
  const text = normalizeText(value).replace(/[$,]/g, "");
  if (!text) return false;
  return Number.isFinite(Number(text));
}

// Shape each kit row had in the old gold sheet: Quadratec PN and MPN are both
// the kit Name, Description is the Display Name, no UPC, no surcharge.
function kitRowToSheetRow(row) {
  const name = normalizeText(row?.Name);
  return {
    "Quadratec PN": name,
    MPN: name,
    Description: normalizeText(row?.["Display Name"]),
    "UPC Code": "",
    Brand: normalizeText(row?.Brand),
    "Retail Price": trimIfString(row?.["Retail Price"]),
    "Wholesale Price": trimIfString(row?.["Wholesale Price"]),
    "Shipping Surcharge": "- None -",
  };
}

function normalizeHeader(cells) {
  const header = (cells || []).map((cell) => normalizeText(cell));
  while (header.length && !header[header.length - 1]) header.pop();
  return header;
}

function assertKitHeader(found, filePath) {
  const same =
    found.length === KIT_HEADER.length &&
    KIT_HEADER.every((name, index) => found[index] === name);
  if (same) return;
  throw new Error(
    `Quadratec kit file ${path.basename(filePath)} has an unexpected header. ` +
      `Expected [${KIT_HEADER.join(", ")}], found [${found.join(", ")}]. ` +
      "Is this the gold kit export?"
  );
}

// Reads the kit file and returns its rows already in gold sheet shape.
// Absent file: { present: false, rows: [] } so the caller keeps the old
// behavior (kits only from the sheet). Wrong header: throws, the import must
// not run on the wrong file.
function loadKitSheetRows({ filePath, XLSX = defaultXLSX, fs = defaultFs } = {}) {
  const counts = { read: 0, noName: 0, noWholesale: 0, nullBrand: 0 };
  if (!filePath || !fs.existsSync(filePath)) {
    return { present: false, filePath, rows: [], counts };
  }

  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assertKitHeader(normalizeHeader(matrix[0]), filePath);

  const rows = [];
  for (const cells of matrix.slice(1)) {
    const raw = {
      Name: cells[0],
      "Display Name": cells[1],
      "Retail Price": cells[2],
      "Wholesale Price": cells[3],
      Brand: cells[4],
    };
    if (!normalizeText(raw.Name)) {
      counts.noName += 1;
      continue;
    }
    counts.read += 1;
    if (!isNumericPrice(raw["Wholesale Price"])) counts.noWholesale += 1;
    if (!normalizeText(raw.Brand)) counts.nullBrand += 1;
    rows.push(kitRowToSheetRow(raw));
  }

  return { present: true, filePath, rows, counts };
}

// Appends the kit rows below the sheet rows. A PN present in both files keeps
// the sheet row (the kit row is skipped), like the hand-merged sheet did.
function mergeKitRows(sheetRows, kitRows) {
  const sheetPns = new Set();
  for (const row of sheetRows) {
    const pn = normalizeText(row?.["Quadratec PN"]);
    if (pn) sheetPns.add(pn);
  }

  const appended = [];
  let skipped = 0;
  for (const row of kitRows) {
    if (sheetPns.has(normalizeText(row?.["Quadratec PN"]))) {
      skipped += 1;
      continue;
    }
    appended.push(row);
  }

  return { rows: sheetRows.concat(appended), appended: appended.length, skipped };
}

module.exports = {
  KIT_HEADER,
  kitRowToSheetRow,
  normalizeHeader,
  assertKitHeader,
  loadKitSheetRows,
  mergeKitRows,
};
