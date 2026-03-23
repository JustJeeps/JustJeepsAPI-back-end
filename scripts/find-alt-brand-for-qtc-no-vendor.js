const fs = require("fs");
const path = require("path");
const prisma = require("../lib/prisma");

async function run() {
  const matches = await prisma.$queryRawUnsafe(`
    WITH missing_qtc AS (
      SELECT
        p.sku AS qtc_sku,
        p.quadratec_code,
        REPLACE(p.sku, 'QTC-', '') AS core_sku
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
    )
    SELECT
      m.qtc_sku,
      m.quadratec_code,
      m.core_sku,
      vp2.product_sku AS alt_product_sku,
      vp2.vendor_sku AS alt_vendor_sku,
      vp2.vendor_cost_usd AS alt_vendor_cost_usd,
      vp2.vendor_cost AS alt_vendor_cost,
      vp2.quadratec_sku AS alt_quadratec_sku,
      p2.brand_name AS alt_brand_name,
      p2.jj_prefix AS alt_jj_prefix,
      CASE
        WHEN vp2.quadratec_sku = m.core_sku THEN 'quadratec_sku_match'
        WHEN vp2.vendor_sku = m.quadratec_code THEN 'vendor_sku_equals_quadratec_code'
        WHEN vp2.vendor_sku LIKE '%' || m.core_sku THEN 'vendor_sku_suffix_match'
        ELSE 'other'
      END AS match_type
    FROM missing_qtc m
    JOIN "VendorProduct" vp2
      ON vp2.vendor_id = 4
     AND vp2.product_sku NOT LIKE 'QTC-%'
     AND vp2.vendor_cost_usd IS NOT NULL
     AND vp2.vendor_cost_usd > 0
     AND (
          vp2.quadratec_sku = m.core_sku
          OR vp2.vendor_sku = m.quadratec_code
          OR vp2.vendor_sku LIKE '%' || m.core_sku
     )
    LEFT JOIN "Product" p2
      ON p2.sku = vp2.product_sku
    ORDER BY m.qtc_sku, vp2.product_sku;
  `);

  const uniqueRecoverable = new Set(matches.map((row) => row.qtc_sku));

  const summary = {
    candidate_rows: matches.length,
    unique_qtc_skus_recoverable: uniqueRecoverable.size,
  };

  const reportsDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const jsonPath = path.join(reportsDir, "qtc-no-vendor-row-alt-brand-matches.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, matches }, null, 2));

  const csvPath = path.join(reportsDir, "qtc-no-vendor-row-alt-brand-matches.csv");
  const header = [
    "qtc_sku",
    "quadratec_code",
    "core_sku",
    "alt_product_sku",
    "alt_vendor_sku",
    "alt_vendor_cost_usd",
    "alt_vendor_cost",
    "alt_quadratec_sku",
    "alt_brand_name",
    "alt_jj_prefix",
    "match_type",
  ];

  const csv = [
    header.join(","),
    ...matches.map((row) =>
      header
        .map((key) => {
          const value = row[key] ?? "";
          return `"${String(value).replace(/"/g, '""')}"`;
        })
        .join(",")
    ),
  ].join("\n");

  fs.writeFileSync(csvPath, csv);

  console.log(
    JSON.stringify(
      {
        summary,
        csv: csvPath,
        json: jsonPath,
        sample: matches.slice(0, 20),
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
