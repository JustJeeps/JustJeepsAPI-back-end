const fs = require("fs");
const path = require("path");
const prisma = require("../lib/prisma");

async function run() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      p.sku,
      p.jj_prefix,
      p.brand_name,
      p.status,
      p.quadratec_code
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

  const outputDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "qtc-no-vendor-row-status-ne2-no-trailing.csv");

  const header = ["sku", "jj_prefix", "brand_name", "status", "quadratec_code"];
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
        sample: rows.slice(0, 20),
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
