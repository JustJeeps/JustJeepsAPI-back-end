const prisma = require("../lib/prisma");

async function run() {
  const recoverableRows = await prisma.$queryRawUnsafe(`
    WITH base AS (
      SELECT p.sku, p.jj_prefix, p.brand_name, p.quadratec_code, p.status
      FROM "Product" p
      WHERE (
        LOWER(COALESCE(p.brand_name, '')) = 'quadratec'
        OR UPPER(COALESCE(p.jj_prefix, '')) = 'QTC'
      )
        AND p.sku NOT LIKE '%-'
        AND COALESCE(p.status, 0) <> 2
    ),
    missing_cost AS (
      SELECT b.*
      FROM base b
      WHERE NOT EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = 4
          AND vp.product_sku = b.sku
          AND vp.vendor_cost_usd IS NOT NULL
          AND vp.vendor_cost_usd > 0
      )
    ),
    recoverable AS (
      SELECT
        m.sku,
        m.jj_prefix,
        m.brand_name,
        m.quadratec_code,
        vp2.product_sku AS other_product_sku,
        vp2.vendor_sku AS other_vendor_sku,
        vp2.vendor_cost_usd AS other_vendor_cost_usd,
        vp2.quadratec_sku AS other_quadratec_sku
      FROM missing_cost m
      JOIN "VendorProduct" vp2
        ON vp2.vendor_id = 4
       AND vp2.product_sku <> m.sku
       AND vp2.product_sku NOT LIKE 'QTC-%'
       AND vp2.vendor_cost_usd IS NOT NULL
       AND vp2.vendor_cost_usd > 0
       AND (
            vp2.quadratec_sku = REPLACE(m.sku, 'QTC-', '')
            OR vp2.vendor_sku = m.quadratec_code
       )
    )
    SELECT * FROM recoverable;
  `);

  const counts = await prisma.$queryRawUnsafe(`
    WITH base AS (
      SELECT p.sku, p.jj_prefix, p.brand_name, p.status
      FROM "Product" p
      WHERE (
        LOWER(COALESCE(p.brand_name, '')) = 'quadratec'
        OR UPPER(COALESCE(p.jj_prefix, '')) = 'QTC'
      )
        AND p.sku NOT LIKE '%-'
        AND COALESCE(p.status, 0) <> 2
    )
    SELECT
      COUNT(*)::int AS base_total,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
          FROM "VendorProduct" vp
          WHERE vp.vendor_id = 4
            AND vp.product_sku = base.sku
            AND vp.vendor_cost_usd IS NOT NULL
            AND vp.vendor_cost_usd > 0
        )
      )::int AS missing_cost_total,
      COUNT(*) FILTER (WHERE sku LIKE '%-')::int AS trailing_dash_total,
      COUNT(*) FILTER (
        WHERE sku LIKE '%-'
          AND NOT EXISTS (
            SELECT 1
            FROM "VendorProduct" vp
            WHERE vp.vendor_id = 4
              AND vp.product_sku = base.sku
              AND vp.vendor_cost_usd IS NOT NULL
              AND vp.vendor_cost_usd > 0
          )
      )::int AS trailing_dash_missing_cost
    FROM base;
  `);

  const missingSkus = await prisma.$queryRawUnsafe(`
    WITH base AS (
      SELECT p.sku, p.jj_prefix, p.brand_name, p.status
      FROM "Product" p
      WHERE (
        LOWER(COALESCE(p.brand_name, '')) = 'quadratec'
        OR UPPER(COALESCE(p.jj_prefix, '')) = 'QTC'
      )
        AND p.sku NOT LIKE '%-'
        AND COALESCE(p.status, 0) <> 2
    )
    SELECT b.sku, b.jj_prefix, b.brand_name, b.status
    FROM base b
    WHERE NOT EXISTS (
      SELECT 1
      FROM "VendorProduct" vp
      WHERE vp.vendor_id = 4
        AND vp.product_sku = b.sku
        AND vp.vendor_cost_usd IS NOT NULL
        AND vp.vendor_cost_usd > 0
    )
    ORDER BY b.sku
    LIMIT 25;
  `);

  const breakdown = await prisma.$queryRawUnsafe(`
    WITH base AS (
      SELECT p.sku, p.jj_prefix, p.brand_name, p.status
      FROM "Product" p
      WHERE (
        LOWER(COALESCE(p.brand_name, '')) = 'quadratec'
        OR UPPER(COALESCE(p.jj_prefix, '')) = 'QTC'
      )
        AND p.sku NOT LIKE '%-'
        AND COALESCE(p.status, 0) <> 2
    ),
    status AS (
      SELECT
        b.sku,
        EXISTS (
          SELECT 1 FROM "VendorProduct" vp
          WHERE vp.vendor_id = 4 AND vp.product_sku = b.sku
        ) AS has_vp_row,
        EXISTS (
          SELECT 1 FROM "VendorProduct" vp
          WHERE vp.vendor_id = 4
            AND vp.product_sku = b.sku
            AND vp.vendor_cost_usd IS NOT NULL
            AND vp.vendor_cost_usd > 0
        ) AS has_cost,
        (b.sku LIKE '%-') AS trailing_dash,
        (b.sku LIKE '% %') AS has_space
      FROM base b
    )
    SELECT
      COUNT(*)::int AS base_total,
      COUNT(*) FILTER (WHERE has_vp_row)::int AS with_vp_row,
      COUNT(*) FILTER (WHERE NOT has_vp_row)::int AS no_vp_row,
      COUNT(*) FILTER (WHERE has_vp_row AND NOT has_cost)::int AS vp_row_no_cost,
      COUNT(*) FILTER (WHERE NOT has_cost)::int AS missing_cost_total,
      COUNT(*) FILTER (WHERE NOT has_cost AND trailing_dash)::int AS missing_cost_trailing_dash,
      COUNT(*) FILTER (WHERE NOT has_cost AND NOT trailing_dash)::int AS missing_cost_not_trailing_dash,
      COUNT(*) FILTER (WHERE NOT has_cost AND has_space)::int AS missing_cost_with_space,
      COUNT(*) FILTER (WHERE NOT has_cost AND NOT trailing_dash AND NOT has_space)::int AS missing_cost_clean_format
    FROM status;
  `);

  const recoverableUnique = new Set(recoverableRows.map((r) => r.sku)).size;

  console.log(
    JSON.stringify(
      {
        base_total: counts[0].base_total,
        missing_cost_total: counts[0].missing_cost_total,
        trailing_dash_total: counts[0].trailing_dash_total,
        trailing_dash_missing_cost: counts[0].trailing_dash_missing_cost,
        recoverable_under_other_brand_with_cost: recoverableUnique,
        recoverable_rows: recoverableRows.length,
        recoverable_sample: recoverableRows.slice(0, 10),
        missing_sample: missingSkus,
        breakdown: breakdown[0],
      },
      null,
      2
    )
  );
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
