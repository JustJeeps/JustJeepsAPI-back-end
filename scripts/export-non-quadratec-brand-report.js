const fs = require("fs");
const path = require("path");

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function run() {
  const inputPath = path.join(
    __dirname,
    "..",
    "reports",
    "qtc-missing-vs-feed-columns.json"
  );

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing source report: ${inputPath}`);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const matches = data.matches || [];

  const flatRows = [];

  for (const row of matches) {
    for (const cost of row.cost_feed_matches || []) {
      flatRows.push({
        qtc_sku: row.qtc_sku,
        core_sku: row.core_sku,
        source: "cost",
        brand: cost.brand,
        original_brand: cost.original_brand,
        mpn: cost.mpn,
        quadratec_pn: cost.quadratec_pn,
        wholesale_price: cost.wholesale_price,
        retail_price: cost.retail_price,
      });
    }

    for (const inv of row.inv_feed_matches || []) {
      flatRows.push({
        qtc_sku: row.qtc_sku,
        core_sku: row.core_sku,
        source: "inventory",
        brand: inv.brand,
        original_brand: inv.original_brand,
        mpn: inv.mpn,
        quadratec_pn: inv.quadratec_pn,
        wholesale_price: inv.wholesale_price,
        retail_price: "",
        inventory_total: inv.inventory_total,
      });
    }
  }

  flatRows.sort((a, b) => {
    const brandCmp = String(a.brand).localeCompare(String(b.brand));
    if (brandCmp !== 0) return brandCmp;
    return String(a.qtc_sku).localeCompare(String(b.qtc_sku));
  });

  const brandCounts = new Map();
  const uniqueByBrand = new Map();

  for (const row of flatRows) {
    const brand = row.brand || "(unknown)";
    brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);

    if (!uniqueByBrand.has(brand)) uniqueByBrand.set(brand, new Set());
    uniqueByBrand.get(brand).add(row.qtc_sku);
  }

  const reportsDir = path.join(__dirname, "..", "reports");

  const detailedPath = path.join(
    reportsDir,
    "qtc-missing-non-quadratec-brand-detailed.csv"
  );
  const detailedHeader = [
    "brand",
    "qtc_sku",
    "core_sku",
    "source",
    "original_brand",
    "mpn",
    "quadratec_pn",
    "wholesale_price",
    "retail_price",
    "inventory_total",
  ];

  const detailedCsv = [
    detailedHeader.join(","),
    ...flatRows.map((row) =>
      detailedHeader.map((key) => csvEscape(row[key])).join(",")
    ),
  ].join("\n");

  fs.writeFileSync(detailedPath, detailedCsv);

  const summaryRows = [...brandCounts.entries()]
    .map(([brand, count]) => ({
      brand,
      row_count: count,
      unique_qtc_sku_count: uniqueByBrand.get(brand)?.size || 0,
      qtc_skus: [...(uniqueByBrand.get(brand) || [])].sort().join(" | "),
    }))
    .sort((a, b) => b.row_count - a.row_count || a.brand.localeCompare(b.brand));

  const summaryPath = path.join(
    reportsDir,
    "qtc-missing-non-quadratec-brand-summary.csv"
  );
  const summaryHeader = [
    "brand",
    "row_count",
    "unique_qtc_sku_count",
    "qtc_skus",
  ];

  const summaryCsv = [
    summaryHeader.join(","),
    ...summaryRows.map((row) =>
      summaryHeader.map((key) => csvEscape(row[key])).join(",")
    ),
  ].join("\n");

  fs.writeFileSync(summaryPath, summaryCsv);

  console.log(
    JSON.stringify(
      {
        detailed_report: detailedPath,
        summary_report: summaryPath,
        brand_counts: summaryRows.map(({ brand, row_count }) => ({
          brand,
          count: row_count,
        })),
      },
      null,
      2
    )
  );
}

run();
