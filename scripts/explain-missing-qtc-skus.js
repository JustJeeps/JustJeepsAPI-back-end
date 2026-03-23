const prisma = require("../lib/prisma");

const skus = [
  "QTC-55100-0009",
  "QTC-55100-0205",
  "QTC-55100-0505",
  "QTC-55100-0511",
  "QTC-55111-0301",
  "QTC-55100-0507",
  "QTC-55213-16",
  "QTC-97109-1084",
  "QTC-55100-0003",
  "QTC-55100-0700",
  "QTC-97109-1129",
  "QTC-55100-0034",
  "QTC-55100-0200",
  "QTC-55100-0002",
  "QTC-55111-0300",
  "QTC-55100-0510",
  "QTC-55111-0007",
  "QTC-55111-0002",
  "QTC-55100-0203",
  "QTC-55100-0504",
  "QTC-55100-0513",
  "QTC-55100-0501",
  "QTC-13009-0320",
  "QTC-55100-0001",
  "QTC-55100-0506",
  "QTC-13009-0321",
  "QTC-55100-0503",
  "QTC-55100-0014",
  "QTC-55111-09",
  "QTC-55111-0003",
  "QTC-55100-0509",
  "QTC-55213-17",
  "QTC-55100-0508",
  "QTC-55100-0300",
  "QTC-55213-03",
  "QTC-55213-06",
  "QTC-55213-02",
  "QTC-55100-0010",
  "QTC-55100-0512",
  "QTC-55111-000",
  "QTC-55100-0005",
  "QTC-55213-070",
  "QTC-97109-1138",
  "QTC-97109-1187",
  "QTC-97109-1139",
  "QTC-97109-1154",
  "QTC-97109-1191",
  "QTC-97109-1194",
  "QTC-97109-1193",
  "QTC-97109-1192",
  "QTC-97109-0425",
  "QTC-97109-1155",
  "QTC-97109-1158",
  "QTC-97109-1159",
];

async function run() {
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: {
      sku: true,
      jj_prefix: true,
      status: true,
      brand_name: true,
      quadratec_code: true,
    },
  });

  const vendorRows = await prisma.vendorProduct.findMany({
    where: {
      vendor_id: 4,
      product_sku: { in: skus },
    },
    select: {
      product_sku: true,
      vendor_sku: true,
      vendor_cost_usd: true,
      vendor_cost: true,
      quadratec_sku: true,
    },
  });

  const productsBySku = new Map(products.map((p) => [p.sku, p]));
  const vendorBySku = new Map(vendorRows.map((v) => [v.product_sku, v]));

  const details = skus.map((sku) => {
    const p = productsBySku.get(sku);
    const v = vendorBySku.get(sku);

    const reasons = [];
    if (!p) {
      reasons.push("not_in_product_table");
    } else {
      if ((p.jj_prefix || "").toUpperCase() !== "QTC") reasons.push("jj_prefix_not_qtc");
      if ((p.status ?? 0) === 2) reasons.push("status_is_2");
      if (sku.endsWith("-")) reasons.push("sku_ends_with_dash");
      if (v) reasons.push("has_vendorproduct_row_vendor_4");
    }

    return {
      sku,
      in_product: !!p,
      jj_prefix: p?.jj_prefix ?? null,
      status: p?.status ?? null,
      brand_name: p?.brand_name ?? null,
      quadratec_code: p?.quadratec_code ?? null,
      has_vendor_row_vendor_4: !!v,
      vendor_sku: v?.vendor_sku ?? null,
      vendor_cost_usd: v?.vendor_cost_usd ?? null,
      quadratec_sku: v?.quadratec_sku ?? null,
      excluded_by_rules: reasons,
    };
  });

  const summary = {
    total_input_skus: skus.length,
    in_product_table: details.filter((d) => d.in_product).length,
    not_in_product_table: details.filter((d) => !d.in_product).length,
    status_is_2: details.filter((d) => d.status === 2).length,
    sku_ends_with_dash: details.filter((d) => d.sku.endsWith("-")).length,
    has_vendorproduct_row_vendor_4: details.filter((d) => d.has_vendor_row_vendor_4).length,
    matches_report_criteria: details.filter(
      (d) =>
        d.in_product &&
        (d.jj_prefix || "").toUpperCase() === "QTC" &&
        d.status !== 2 &&
        !d.sku.endsWith("-") &&
        !d.has_vendor_row_vendor_4
    ).length,
  };

  console.log(JSON.stringify({ summary, details }, null, 2));
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
