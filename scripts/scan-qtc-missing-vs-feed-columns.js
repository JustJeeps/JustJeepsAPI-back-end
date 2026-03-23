const fs = require("fs");
const path = require("path");
const prisma = require("../lib/prisma");
const quadratecCost = require("../prisma/seeds/api-calls/quadratec-excel.js");
const quadratecInventory = require("../prisma/seeds/api-calls/quad-inventory-api.js");

function normalize(value) {
  return (value ?? "").toString().trim();
}

function canonicalSku(value) {
  return normalize(value).replace(/\s+/g, "-").toUpperCase();
}

async function run() {
  const missingQtc = await prisma.$queryRawUnsafe(`
    SELECT p.sku, p.quadratec_code, REPLACE(p.sku, 'QTC-', '') AS core_sku
    FROM "Product" p
    WHERE UPPER(COALESCE(p.jj_prefix, '')) = 'QTC'
      AND p.sku NOT LIKE '%-'
      AND COALESCE(p.status, 0) <> 2
      AND NOT EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = 4
          AND vp.product_sku = p.sku
      )
    ORDER BY p.sku;
  `);

  const costRows = quadratecCost();
  const invRows = quadratecInventory();

  const matches = [];

  for (const item of missingQtc) {
    const core = normalize(item.core_sku);
    const coreCanonical = canonicalSku(core);

    const costMatches = costRows.filter((r) => {
      const quad = canonicalSku(r.quadratec_sku);
      const mpn = canonicalSku(r.MPN);
      return quad === coreCanonical || mpn === coreCanonical;
    });

    const invMatches = invRows.filter((r) => {
      const quad = canonicalSku(r.quadratec_sku);
      const mpn = canonicalSku(r.MPN);
      return quad === coreCanonical || mpn === coreCanonical;
    });

    const nonQuadratecCost = costMatches.filter(
      (r) => normalize(r.brand).toLowerCase() !== "quadratec"
    );
    const nonQuadratecInv = invMatches.filter(
      (r) => normalize(r.brand).toLowerCase() !== "quadratec"
    );

    matches.push({
      qtc_sku: item.sku,
      core_sku: core,
      quadratec_code: item.quadratec_code,
      cost_feed_match_count: costMatches.length,
      inv_feed_match_count: invMatches.length,
      non_quadratec_cost_match_count: nonQuadratecCost.length,
      non_quadratec_inv_match_count: nonQuadratecInv.length,
      cost_feed_matches: nonQuadratecCost.map((r) => ({
        brand: r.brand,
        original_brand: r.original_brand,
        mpn: r.MPN,
        quadratec_pn: r.quadratec_sku,
        wholesale_price: r.wholesalePrice,
        retail_price: r.retailPrice,
        quadratec_code: r.quadratec_code,
        quadratec_code_alt: r.quadratec_code_alt,
      })),
      inv_feed_matches: nonQuadratecInv.map((r) => ({
        brand: r.brand,
        original_brand: r.original_brand,
        mpn: r.MPN,
        quadratec_pn: r.quadratec_sku,
        wholesale_price: r.wholesalePrice,
        inventory_total: r.quadratec_inventory,
        quadratec_code: r.quadratec_code,
        quadratec_code_alt: r.quadratec_code_alt,
      })),
    });
  }

  const withFeedNonQuadratec = matches.filter(
    (m) => m.non_quadratec_cost_match_count > 0 || m.non_quadratec_inv_match_count > 0
  );

  const brandCounts = new Map();
  for (const row of withFeedNonQuadratec) {
    for (const candidate of row.cost_feed_matches) {
      const brand = candidate.brand || "(unknown)";
      brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);
    }
    for (const candidate of row.inv_feed_matches) {
      const brand = candidate.brand || "(unknown)";
      brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);
    }
  }

  const reportsDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const jsonPath = path.join(reportsDir, "qtc-missing-vs-feed-columns.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        summary: {
          total_qtc_missing_no_vendor_row: matches.length,
          found_in_non_quadratec_feed_rows: withFeedNonQuadratec.length,
          feed_non_quadratec_brand_counts: [...brandCounts.entries()]
            .map(([brand, count]) => ({ brand, count }))
            .sort((a, b) => b.count - a.count),
        },
        sample_for_97109_1060: matches.find((m) => m.qtc_sku === "QTC-97109-1060") || null,
        matches,
      },
      null,
      2
    )
  );

  const csvPath = path.join(reportsDir, "qtc-missing-vs-feed-columns.csv");
  const header = [
    "qtc_sku",
    "core_sku",
    "cost_feed_match_count",
    "inv_feed_match_count",
    "non_quadratec_cost_match_count",
    "non_quadratec_inv_match_count",
  ];
  const csv = [
    header.join(","),
    ...matches.map((m) =>
      header
        .map((key) => `"${String(m[key] ?? "").replace(/"/g, '""')}"`)
        .join(",")
    ),
  ].join("\n");
  fs.writeFileSync(csvPath, csv);

  console.log(
    JSON.stringify(
      {
        summary: {
          total_qtc_missing_no_vendor_row: matches.length,
          found_in_non_quadratec_feed_rows: withFeedNonQuadratec.length,
          feed_non_quadratec_brand_counts: [...brandCounts.entries()]
            .map(([brand, count]) => ({ brand, count }))
            .sort((a, b) => b.count - a.count),
        },
        sample_for_97109_1060: matches.find((m) => m.qtc_sku === "QTC-97109-1060") || null,
        csv: csvPath,
        json: jsonPath,
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
