const fs = require("fs");
const path = require("path");
const prisma = require("../lib/prisma");

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

  const detailed = [];

  for (const item of missingQtc) {
    const coreSku = item.core_sku;

    const productCandidates = await prisma.$queryRawUnsafe(`
      SELECT p.sku, p.brand_name, p.jj_prefix, p.quadratec_code, p.status
      FROM "Product" p
      WHERE p.sku <> $1
        AND LOWER(COALESCE(p.brand_name, '')) <> 'quadratec'
        AND (
          p.sku ILIKE '%' || $2 || '%'
          OR p.quadratec_code ILIKE '%' || $2 || '%'
        )
      ORDER BY p.sku
      LIMIT 25;
    `, item.sku, coreSku);

    const vendorCandidates = await prisma.$queryRawUnsafe(`
      SELECT
        vp.product_sku,
        vp.vendor_sku,
        vp.vendor_cost_usd,
        vp.vendor_cost,
        vp.quadratec_sku,
        p.brand_name,
        p.jj_prefix,
        CASE
          WHEN vp.quadratec_sku = $1 THEN 'quadratec_sku_exact'
          WHEN vp.vendor_sku = $2 THEN 'vendor_sku_exact_quadratec_code'
          WHEN vp.vendor_sku ILIKE '%' || $1 || '%' THEN 'vendor_sku_contains_core'
          ELSE 'other'
        END AS match_type
      FROM "VendorProduct" vp
      LEFT JOIN "Product" p ON p.sku = vp.product_sku
      WHERE vp.vendor_id = 4
        AND vp.product_sku NOT LIKE 'QTC-%'
        AND LOWER(COALESCE(p.brand_name, '')) <> 'quadratec'
        AND (
          vp.quadratec_sku = $1
          OR vp.vendor_sku = $2
          OR vp.vendor_sku ILIKE '%' || $1 || '%'
        )
      ORDER BY vp.product_sku
      LIMIT 25;
    `, coreSku, item.quadratec_code);

    detailed.push({
      qtc_sku: item.sku,
      quadratec_code: item.quadratec_code,
      core_sku: coreSku,
      other_brand_products_found: productCandidates.length,
      other_brand_vendor_rows_found: vendorCandidates.length,
      other_brand_vendor_rows_with_cost: vendorCandidates.filter((v) => Number(v.vendor_cost_usd) > 0).length,
      product_candidates: productCandidates,
      vendor_candidates: vendorCandidates,
    });
  }

  const withAnyOtherBrandProduct = detailed.filter((d) => d.other_brand_products_found > 0);
  const withAnyOtherBrandVendorRow = detailed.filter((d) => d.other_brand_vendor_rows_found > 0);
  const recoverableWithCost = detailed.filter((d) => d.other_brand_vendor_rows_with_cost > 0);

  const brandCounts = new Map();
  for (const row of detailed) {
    for (const candidate of row.vendor_candidates) {
      const brand = candidate.brand_name || "(unknown)";
      brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);
    }
  }

  const summary = {
    total_qtc_missing_vendor_rows: detailed.length,
    qtc_found_under_any_other_brand_product: withAnyOtherBrandProduct.length,
    qtc_found_under_any_other_brand_vendor_row: withAnyOtherBrandVendorRow.length,
    qtc_recoverable_from_other_brand_vendor_cost: recoverableWithCost.length,
    vendor_candidate_brand_counts: [...brandCounts.entries()]
      .map(([brand, count]) => ({ brand, count }))
      .sort((a, b) => b.count - a.count),
  };

  const reportsDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const jsonPath = path.join(reportsDir, "qtc-missing-other-brand-scan.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, detailed }, null, 2));

  const csvPath = path.join(reportsDir, "qtc-missing-other-brand-scan.csv");
  const header = [
    "qtc_sku",
    "quadratec_code",
    "core_sku",
    "other_brand_products_found",
    "other_brand_vendor_rows_found",
    "other_brand_vendor_rows_with_cost",
  ];

  const csv = [
    header.join(","),
    ...detailed.map((row) =>
      header
        .map((key) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`)
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
        recoverable_sample: recoverableWithCost.slice(0, 20).map((r) => ({
          qtc_sku: r.qtc_sku,
          vendor_candidates: r.vendor_candidates,
        })),
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
