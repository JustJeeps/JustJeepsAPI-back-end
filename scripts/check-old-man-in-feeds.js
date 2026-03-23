const costRows = require('../prisma/seeds/api-calls/quadratec-excel.js')();
const invRows = require('../prisma/seeds/api-calls/quad-inventory-api.js')();

function summarize(rows, source) {
  const oldManRows = rows.filter((row) => {
    const brand = String(row.brand || '').toLowerCase();
    const originalBrand = String(row.original_brand || '').toLowerCase();
    return brand.includes('old man') || originalBrand.includes('old man');
  });

  const arbLike = oldManRows
    .filter((row) => String(row.quadratec_sku || '').trim().length > 0)
    .map((row) => ({
      source,
      brand: row.brand || null,
      original_brand: row.original_brand || null,
      quadratec_sku: row.quadratec_sku || null,
      potential_arb_sku: row.quadratec_sku ? `ARB-${String(row.quadratec_sku).trim()}` : null,
      quadratec_code: row.quadratec_code || null,
      wholesalePrice: row.wholesalePrice || null,
      quadratec_inventory: row.quadratec_inventory || null,
    }));

  return {
    source,
    old_man_row_count: oldManRows.length,
    sample: arbLike.slice(0, 20),
  };
}

const costSummary = summarize(costRows, 'cost');
const invSummary = summarize(invRows, 'inventory');

console.log(
  JSON.stringify(
    {
      cost_old_man_rows: costSummary.old_man_row_count,
      inventory_old_man_rows: invSummary.old_man_row_count,
      total_old_man_rows: costSummary.old_man_row_count + invSummary.old_man_row_count,
      sample: [...costSummary.sample, ...invSummary.sample].slice(0, 30),
    },
    null,
    2
  )
);
