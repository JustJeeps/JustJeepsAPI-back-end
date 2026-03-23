const prisma = require('../lib/prisma');

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    WITH arb AS (
      SELECT p.sku, p.quadratec_code, p.brand_name, p.status
      FROM "Product" p
      WHERE UPPER(COALESCE(p.jj_prefix, '')) = 'ARB'
    ),
    arb_filtered AS (
      SELECT *
      FROM arb
      WHERE COALESCE(status, 0) <> 2
        AND sku NOT LIKE '%-'
    ),
    arb_missing_vendor4 AS (
      SELECT a.*
      FROM arb_filtered a
      WHERE NOT EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = 4
          AND vp.product_sku = a.sku
      )
    ),
    old_man_emu AS (
      SELECT p.sku, p.brand_name
      FROM "Product" p
      WHERE LOWER(COALESCE(p.brand_name, '')) LIKE '%old man%'
    ),
    matches AS (
      SELECT
        a.sku AS arb_sku,
        a.quadratec_code AS arb_quadratec_code,
        vp2.product_sku AS old_man_emu_product_sku,
        vp2.vendor_sku AS old_man_emu_vendor_sku,
        vp2.quadratec_sku AS old_man_emu_quadratec_sku,
        vp2.vendor_cost_usd AS old_man_emu_vendor_cost_usd,
        ome.brand_name AS old_man_emu_brand
      FROM arb_missing_vendor4 a
      JOIN "VendorProduct" vp2
        ON vp2.vendor_id = 4
       AND vp2.product_sku <> a.sku
      JOIN old_man_emu ome
        ON ome.sku = vp2.product_sku
      WHERE (
        vp2.quadratec_sku = REPLACE(a.sku, 'ARB-', '')
        OR vp2.vendor_sku = a.quadratec_code
      )
    )
    SELECT
      (SELECT COUNT(*)::int FROM arb_filtered) AS arb_total_filtered,
      (SELECT COUNT(*)::int FROM arb_missing_vendor4) AS arb_missing_vendor4,
      COALESCE(
        (
          SELECT json_agg(DISTINCT brand_name)
          FROM old_man_emu
        ),
        '[]'::json
      ) AS old_man_brand_variants,
      (SELECT COUNT(DISTINCT arb_sku)::int FROM matches) AS arb_missing_found_under_old_man_emu,
      (SELECT COUNT(*)::int FROM matches) AS candidate_match_rows,
      COALESCE(
        (
          SELECT json_agg(t)
          FROM (
            SELECT *
            FROM matches
            ORDER BY arb_sku
            LIMIT 50
          ) t
        ),
        '[]'::json
      ) AS sample
  `);

  const result = rows[0] || {};
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
