const fs = require("fs");
const path = require("path");
const prisma = require("../lib/prisma");

async function run() {
  const rows = await prisma.$queryRawUnsafe(`
    WITH base AS (
      SELECT p.sku, p.jj_prefix, p.brand_name, p.status, p.quadratec_code
      FROM "Product" p
      WHERE (
        LOWER(COALESCE(p.brand_name, '')) = 'quadratec'
        OR UPPER(COALESCE(p.jj_prefix, '')) = 'QTC'
      )
      AND p.sku NOT LIKE '%-'
      AND COALESCE(p.status, 0) <> 2
    )
    SELECT
      b.sku,
      b.jj_prefix,
      b.brand_name,
      b.status,
      b.quadratec_code,
      EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = 4
          AND vp.product_sku = b.sku
      ) AS has_vendor_row,
      EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = 4
          AND vp.product_sku = b.sku
          AND vp.vendor_cost_usd IS NOT NULL
          AND vp.vendor_cost_usd > 0
      ) AS has_positive_cost,
      (
        SELECT vp2.product_sku
        FROM "VendorProduct" vp2
        WHERE vp2.vendor_id = 4
          AND vp2.product_sku <> b.sku
          AND vp2.product_sku NOT LIKE 'QTC-%'
          AND vp2.vendor_cost_usd IS NOT NULL
          AND vp2.vendor_cost_usd > 0
          AND (
            vp2.quadratec_sku = REPLACE(b.sku, 'QTC-', '')
            OR vp2.vendor_sku = b.quadratec_code
          )
        LIMIT 1
      ) AS alt_product_sku_with_cost
    FROM base b
    WHERE NOT EXISTS (
      SELECT 1
      FROM "VendorProduct" vp
      WHERE vp.vendor_id = 4
        AND vp.product_sku = b.sku
        AND vp.vendor_cost_usd IS NOT NULL
        AND vp.vendor_cost_usd > 0
    )
    ORDER BY b.sku;
  `);

  const outputDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    "qtc-missing-cost-status-ne2-no-trailing.csv"
  );

  const header = [
    "sku",
    "jj_prefix",
    "brand_name",
    "status",
    "quadratec_code",
    "has_vendor_row",
    "has_positive_cost",
    "alt_product_sku_with_cost",
  ];

  const csv = [
    header.join(","),
    ...rows.map((row) =>
      header
        .map((key) => {
          const value = row[key] ?? "";
          return `"${String(value).replace(/"/g, '""')}"`;
        })
        .join(",")
    ),
  ].join("\n");

  fs.writeFileSync(outputPath, csv);

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        count: rows.length,
        recoverable_count: rows.filter((r) => r.alt_product_sku_with_cost).length,
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
