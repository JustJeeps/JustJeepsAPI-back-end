/* eslint-disable no-console */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function normalizeRgaKeystoneFromSearchableSku(searchableSku) {
  if (!searchableSku || !/^REV/i.test(searchableSku)) {
    return null;
  }

  const keystoneSearchableSku = searchableSku.slice(1); // REV... -> EV...

  return {
    keystoneCode: `RGA${keystoneSearchableSku.replace(/[-./_]/g, "")}`,
    keystoneCodeSite: `RGA${keystoneSearchableSku}`,
  };
}

async function main() {
  const rows = await prisma.product.findMany({
    where: {
      jj_prefix: "RGA",
      searchable_sku: {
        startsWith: "REV",
      },
    },
    select: {
      sku: true,
      searchable_sku: true,
      keystone_code: true,
      keystone_code_site: true,
      brand_name: true,
    },
  });

  console.log(`Found ${rows.length} RGA products with searchable_sku starting REV.`);

  let changed = 0;

  for (const row of rows) {
    const normalized = normalizeRgaKeystoneFromSearchableSku(row.searchable_sku);
    if (!normalized) continue;

    const nextBrand = row.brand_name || "Revolution Gear";

    const needsUpdate =
      row.keystone_code !== normalized.keystoneCode ||
      row.keystone_code_site !== normalized.keystoneCodeSite ||
      row.brand_name !== nextBrand;

    if (!needsUpdate) continue;

    await prisma.product.update({
      where: { sku: row.sku },
      data: {
        keystone_code: normalized.keystoneCode,
        keystone_code_site: normalized.keystoneCodeSite,
        brand_name: nextBrand,
      },
    });

    changed += 1;
  }

  console.log(`Updated ${changed} products.`);
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
