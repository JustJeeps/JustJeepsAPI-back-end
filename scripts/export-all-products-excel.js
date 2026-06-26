const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const ExcelJS = require('exceljs');
const prisma = require('../lib/prisma');

function getVendorValue(product, vendorName, key) {
  return product.vendorProducts?.find((vp) => vp.vendor?.name === vendorName)?.[key];
}

function getCompetitorValue(product, competitorName) {
  return product.competitorProducts?.find((cp) => cp.competitor?.name === competitorName)?.competitor_price;
}

async function run() {
  const products = await prisma.product.findMany({
    select: {
      sku: true,
      name: true,
      status: true,
      price: true,
      MAP: true,
      searchable_sku: true,
      jj_prefix: true,
      brand_name: true,
      vendors: true,
      partStatus_meyer: true,
      keystone_code: true,
      meyer_weight: true,
      meyer_length: true,
      meyer_width: true,
      meyer_height: true,
      weight: true,
      length: true,
      width: true,
      height: true,
      shippingFreight: true,
      partsEngine_code: true,
      tdot_url: true,
      part: true,
      thumbnail: true,
      black_friday_sale: true,
      vendorProducts: {
        select: {
          vendor_sku: true,
          vendor_cost: true,
          vendor_inventory: true,
          quadratec_sku: true,
          vendor: {
            select: {
              name: true,
            },
          },
        },
      },
      competitorProducts: {
        select: {
          competitor_price: true,
          competitor: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Product Data');

  sheet.columns = [
    { header: 'JJ Prefix', key: 'jj_prefix' },
    { header: 'JJ SKU', key: 'sku' },
    { header: 'MANUF. SKU', key: 'searchable_sku' },
    { header: 'Price', key: 'price' },
    { header: 'Shipping Freight', key: 'shipping_freight' },
    { header: 'MAP', key: 'MAP' },
    { header: 'Brand Name', key: 'brand_name' },
    { header: 'Vendors', key: 'vendors' },
    { header: 'Meyer Cost', key: 'meyer_cost' },
    { header: 'Meyer Inventory', key: 'meyer_inventory' },
    { header: 'Keystone Cost', key: 'keystone_cost' },
    { header: 'Keystone Inventory', key: 'keystone_inventory' },
    { header: 'Omix Cost', key: 'omix_cost' },
    { header: 'Quadratec Cost', key: 'quadratec_cost' },
    { header: 'Quadratec Inventory', key: 'quadratec_inventory' },
    { header: 'WheelPros Cost', key: 'wheelPros_cost' },
    { header: 'WP inventory', key: 'WP_inventory' },
    { header: 'Tire Discounter Cost', key: 'tireDiscounter_cost' },
    { header: 'Dirty Dog Cost', key: 'dirtyDog_cost' },
    { header: 'Rough Country Cost', key: 'rough_country_cost' },
    { header: 'TDOT Price', key: 'tdot_price' },
    { header: 'PartsEngine Price', key: 'partsEngine_price' },
    { header: 'Lowriders Price', key: 'lowriders_price' },
    { header: 'Status', key: 'status' },
    { header: 'Name', key: 'name' },
    { header: 'Part Status Meyer', key: 'partStatus_meyer' },
    { header: 'Keystone code', key: 'keystone_code' },
    { header: 'Weight', key: 'weight' },
    { header: 'Length', key: 'length' },
    { header: 'Width', key: 'width' },
    { header: 'Height', key: 'height' },
    { header: 'Meyer Weight', key: 'meyer_weight' },
    { header: 'Meyer Length', key: 'meyer_length' },
    { header: 'Meyer Width', key: 'meyer_width' },
    { header: 'Meyer Height', key: 'meyer_height' },
    { header: 'Quadratec SKU', key: 'quadratec_sku' },
    { header: 'Rough Country Inventory', key: 'RC_inventory' },
    { header: 'Omix Inventory', key: 'omix_inventory' },
    { header: 'Part', key: 'part' },
    { header: 'Image', key: 'thumbnail' },
    { header: 'AEV Cost', key: 'aev_cost' },
    { header: 'Keyparts', key: 'keyparts_cost' },
    { header: 'PartsEngine URL', key: 'partsEngine_code' },
    { header: 'TDOT URL', key: 'tdot_url' },
    { header: 'MetalCloak Cost', key: 'metalcloak_cost' },
    { header: 'Alpine Cost', key: 'alpine_cost' },
    { header: 'Sale Code', key: 'black_friday_sale' },
  ];

  for (const product of products) {
    sheet.addRow({
      black_friday_sale: product.black_friday_sale,
      partsEngine_code: product.partsEngine_code,
      tdot_url: product.tdot_url,
      keystone_code: product.keystone_code,
      sku: product.sku,
      name: product.name,
      status: product.status,
      price: product.price,
      MAP: product.MAP,
      searchable_sku: product.searchable_sku,
      jj_prefix: product.jj_prefix,
      brand_name: product.brand_name,
      vendors: product.vendors,
      partStatus_meyer: product.partStatus_meyer,
      weight: product.weight,
      length: product.length,
      width: product.width,
      height: product.height,
      meyer_weight: product.meyer_weight,
      meyer_length: product.meyer_length,
      meyer_width: product.meyer_width,
      meyer_height: product.meyer_height,
      part: product.part,
      thumbnail: product.thumbnail,
      shipping_freight: product.shippingFreight,
      metalcloak_cost: getVendorValue(product, 'MetalCloak', 'vendor_cost'),
      alpine_cost: getVendorValue(product, 'Alpine', 'vendor_cost'),
      meyer_cost: getVendorValue(product, 'Meyer', 'vendor_cost'),
      meyer_inventory: getVendorValue(product, 'Meyer', 'vendor_inventory'),
      keystone_cost: getVendorValue(product, 'Keystone', 'vendor_cost'),
      wheelPros_cost: getVendorValue(product, 'WheelPros', 'vendor_cost'),
      tireDiscounter_cost: getVendorValue(product, 'Tire Discounter', 'vendor_cost'),
      dirtyDog_cost: getVendorValue(product, 'Dirty Dog 4x4', 'vendor_cost'),
      keystone_inventory: getVendorValue(product, 'Keystone', 'vendor_inventory'),
      partsEngine_price: getCompetitorValue(product, 'Parts Engine'),
      lowriders_price: getCompetitorValue(product, 'Lowriders'),
      tdot_price: getCompetitorValue(product, 'TDOT'),
      omix_cost: getVendorValue(product, 'Omix', 'vendor_cost'),
      quadratec_cost: getVendorValue(product, 'Quadratec', 'vendor_cost'),
      rough_country_cost: getVendorValue(product, 'Rough Country', 'vendor_cost'),
      quadratec_sku: getVendorValue(product, 'Quadratec', 'quadratec_sku'),
      quadratec_inventory: getVendorValue(product, 'Quadratec', 'vendor_inventory'),
      RC_inventory: getVendorValue(product, 'Rough Country', 'vendor_inventory'),
      omix_inventory: getVendorValue(product, 'Omix', 'vendor_inventory'),
      aev_cost: getVendorValue(product, 'AEV', 'vendor_cost'),
      keyparts_cost: getVendorValue(product, 'KeyParts', 'vendor_cost'),
      WP_inventory: getVendorValue(product, 'WheelPros', 'vendor_inventory'),
    });
  }

  const outputDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outputDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `AllProducts-${now}.xlsx`);

  await workbook.xlsx.writeFile(outputPath);

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        count: products.length,
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
