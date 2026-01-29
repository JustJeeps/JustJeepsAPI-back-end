const magentoAllProducts = require("../api-calls/magento-allProducts.js");
const vendorsPrefix = require("../hard-code_data/vendors_prefix");

const prisma = require("../../../lib/prisma");

const seedAllProducts = async () => {

const startTime = Date.now();
console.time("Seed Duration"); // Start timer to measure seed duration
  
  try {
    const allProducts = await magentoAllProducts();
    console.log("allProducts", allProducts);

    // Initialize counters for created and updated products
    let createdCount = 0;
    let updatedCount = 0;

    for (const item of allProducts) {
      const {
        sku,
        status,
        name,
        price,
        weight,
        media_gallery_entries,
        custom_attributes,
      } = item;
      // console.log("item", item);

      // Extract jj_prefix from sku by splitting at the first hyphen and taking the first element
      const jjPrefix = item.sku.split("-")[0];

      // Extract searchable_sku from sku by removing characters before the first hyphen
      const searchable_sku = item.sku.slice(item.sku.indexOf("-") + 1);

      // Get the vendor data based on jj_prefix
      const vendorData = vendorsPrefix.find(
        (vendor) => vendor.jj_prefix === jjPrefix
      );


      // Generate meyer_code, keystone_code, and brand_name based on vendor data
      // let meyerCode =
      //   vendorData && vendorData.meyer_code
      //     ? vendorData.meyer_code + searchable_sku
      //     : "";

      let meyerCode =
        vendorData && vendorData.meyer_code
          ? (vendorData.meyer_code + searchable_sku).toUpperCase()
          : "";



      //BESTOP: FOR MEYRcode, add hyphen after the 5 first digits from searchable_sku
      if (jjPrefix === "BST") {
        // Special case for SKU 5240711 - no hyphen formatting
        if (searchable_sku === "5240711") {
          meyerCode = vendorData.meyer_code + searchable_sku;
        } else {
          meyerCode = vendorData.meyer_code + searchable_sku.slice(0, 5) + "-" + 
          searchable_sku.slice(5);
        }
      }

      // YUKON: remove all spaces from meyer_code
        if (jjPrefix === "YUK") {
          meyerCode = (vendorData.meyer_code + searchable_sku)
            .replace(/\s+/g, "") // removes all spaces
            .toUpperCase();
        }

      //CARGOGLIDE: JJ_PREFIX =CGG, FOR KEYSTONE_CODE, remove hyphen from searchable_sku and it should be afte CG. Example is searchable_sku = CG-1000-90, keystone_code = 100090

   


      //Generate keystone_code based on vendor data

      // CODE FOR MICKEY THOMPSON - 3 CODES FROM KEYSTONE
      //     const keystoneCode =
      // vendorData && vendorData.keystone_code
      //   ? jjPrefix === "MKT"
      //     ? vendorData.keystone_code + searchable_sku.slice(-6).replace(/[-.]/g, "")
      //     : vendorData.keystone_code + searchable_sku.replace(/[-.]/g, "")
      //   : "";

      let keystoneCode =
  vendorData && vendorData.keystone_code
    ? jjPrefix === "MKT"
      ? vendorData.keystone_code + searchable_sku.slice(-6)
      : vendorData.keystone_code + searchable_sku.replace(/[-./_]/g, "")
    : "";


 // CARGOGLIDE: Format keystone_code (remove hyphens and place after "CG")
    if (jjPrefix === "CGG") {
    keystoneCode = "CG" + searchable_sku.replace(/-/g, "");
}


      // const keystoneCode =
      //   vendorData && vendorData.keystone_code
      //     ? vendorData.keystone_code +
      //       searchable_sku.replace(/-/g, "").replace(/\./g, "")
      //     : "";

      //Generate quadratec_code based on vendor data
      const quadratecCode =
        vendorData && vendorData.quadratec_code
          ? vendorData.quadratec_code + searchable_sku
          : "";
      console.log("quadratecCode", quadratecCode);

      //generate tdot_code based on competitor data, but we need a space between the prefix and the sku
      const tdotCode =
        vendorData && vendorData.tdot_code
          ? vendorData.tdot_code + " " + searchable_sku
          : "";

    // Generate ctp_code based on vendor dataa
      const ctpCode =
        vendorData && vendorData.ctp_code
          ? vendorData.ctp_code + searchable_sku
          : "";
      console.log("ctpCode", ctpCode);

      //Generate partsEngine_code based on vendor data
    
      // Clean searchable_sku for PartsEngine (replace . / _ space with dash)

      let cleanedSearchableSku = searchable_sku.replace(/[./_\s]/g, "-");

      // Special rule for Bestop (BST): insert hyphen before last two digits
      if (jjPrefix === "BST") {
        cleanedSearchableSku = cleanedSearchableSku.replace(/(\d+)(\d{2})$/, "$1-$2");
      }

      const partsEngineCode =
        vendorData && vendorData.partsEngine_code
          ? `https://www.partsengine.ca/${cleanedSearchableSku}${vendorData.partsEngine_code}`
          : "";


      // Generate tdot_url only if tdot_code is not empty
      const tdotUrl =
      tdotCode && tdotCode.trim() !== ""
        ? `https://www.tdotperformance.ca/catalogsearch/result/?q=${searchable_sku}`
        : null;
      
      console.log("tdotUrl", tdotUrl);


      //kestone_code_site
      // Generate keystone_code_site based on vendor data
      let keystoneCodeSite =
        vendorData && vendorData.keystone_code_site
          ? vendorData.keystone_code_site + searchable_sku
          : "";

      // Yukon override: keystone_code_site should come from the Keystone code

      if (jjPrefix === "YUK") {
        keystoneCodeSite = keystoneCode || "";
      }
      
      //keystone_ftp_brand
      // Generate keystone_ftp_brand based on vendor data
      const keystoneFtpBrand =
        vendorData && vendorData.keystone_ftp_brand
          ? vendorData.keystone_ftp_brand
          : null;

      // console.log("keystoneCodeSite", keystoneCodeSite);

      


      // Generate gentecdirect_code based on vendor data
      const gentecdirectCode =
        vendorData && vendorData.gentecdirect_code
          ? vendorData.gentecdirect_code + searchable_sku
          : "";

      // Generate t14_code based on vendor data (Turn14 Distribution)
      const t14Code =
        vendorData && vendorData.t14_code
          ? vendorData.t14_code + searchable_sku
          : "";
      console.log("t14Code", t14Code);

      // Generate premier_code based on vendor data (Premier Performance)
      const premierCode =
        vendorData && vendorData.premier_code
          ? vendorData.premier_code + searchable_sku
          : "";
      console.log("premierCode", premierCode);

      //Generate brand_name based on vendor data
      const brandName = vendorData ? vendorData.brand_name : "";

      // Generate vendors based on vendor data
      const vendors = vendorData ? vendorData.vendors : "";

      const searchableSku =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "searchable_sku") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      const url_path =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "url_key") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      //get width, length, height from custom_attributes
      const length =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "length") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      const width =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "width") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      const height =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "height") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      //shipping_freight
      const shippingFreight =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "shipping_freight") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

        //part
        const part =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "part") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

        //thumbnail
        const thumbnail =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "thumbnail") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

        // Black Friday Sale - extract the sale category value
        const saleCategoryValue =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "black_friday_sale_attribute") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

        // Determine Black Friday sale discount based on sale category value
        let blackFridaySale = "15%off"; // Default value for empty or unmatched values
        
        if (saleCategoryValue === "4556") {
          blackFridaySale = "20%off";
        } else if (saleCategoryValue === "4557") {
          blackFridaySale = "25%off";
        } else if (saleCategoryValue === "4558") {
          blackFridaySale = "30%off";
        }

        


      console.log("length", length);
      console.log("width", width);
      console.log("height", height);
      console.log("shippingFreight", shippingFreight);
      console.log("part", part);
      console.log("thumbnail", thumbnail);
      console.log("saleCategoryValue", saleCategoryValue);
      console.log("blackFridaySale", blackFridaySale);
      console.log("url_path", url_path);
      console.log("keystone_code_site", keystoneCodeSite);
      console.log("keystone_ftp_brand", keystoneFtpBrand);

      // console.log("url_path", url_path);

      // console.log("check sku", sku);
      //console.log the product when sku is undefined
      if (sku === undefined) {
        // console.log("check item", item);
      }
      // Check if product with given SKU already exists in the database
      const existingProduct = await prisma.product.findUnique({
        where: { sku },
      });

      if (existingProduct) {
        // Update existing product
        await prisma.product.update({
          where: { sku },
          data: {
            name,
            status,
            price,
            weight,
            //if length, width, height and shippingFreight are not undefined, parsefloat them or put them as NULL
            length: length ? parseFloat(length) : null,
            width: width ? parseFloat(width) : null,
            height: height ? parseFloat(height) : null,
            shippingFreight: shippingFreight ? shippingFreight : null,
            part: part? part : null,
            thumbnail: thumbnail? thumbnail : null,
            searchableSku,
            searchable_sku,
            jj_prefix: jjPrefix,
            meyer_code: meyerCode,
            keystone_code: keystoneCode,
            quadratec_code: quadratecCode,
            tdot_code: tdotCode,
            t14_code: t14Code,
            premier_code: premierCode,
            partsEngine_code: partsEngineCode,
            tdot_url: tdotUrl,
            keystone_code_site: keystoneCodeSite,
            keystone_ftp_brand: keystoneFtpBrand,
            ctp_code: ctpCode,
            // gentecdirectCode: gentecdirect_code,
            omix_code:
              jjPrefix === "OA" || jjPrefix === "ALY" || jjPrefix === "RR" || jjPrefix === "HVC"
                ? searchable_sku
                : null,
            brand_name: brandName,
            vendors: vendors,
            black_friday_sale: blackFridaySale,
            // manufacturer_code: manufacturerCode,
            image:
              media_gallery_entries && media_gallery_entries.length > 0
                ? `https://www.justjeeps.com/pub/media/catalog/product/${
                    media_gallery_entries[0]?.file || null
                  }`
                : null,
            url_path: url_path ? `https://www.justjeeps.com/${url_path}.html` : null,
          },
        });
        // console.log(`Product with SKU ${sku} updated.`);
        updatedCount++; // Increment updated product counter
      } else {
        // Create new product
        // console.log("check sku", sku);
        await prisma.product.create({
          data: {
            sku,
            status,
            name,
            price,
            weight,
             //if length, width, height and shippingFreight are not undefined, parsefloat them or put them as NULL
             length: length ? parseFloat(length) : null,
            width: width ? parseFloat(width) : null,
             height: height ? parseFloat(height) : null,
             shippingFreight: shippingFreight ? shippingFreight : null,
             part: part? part : null,
            thumbnail: thumbnail? thumbnail : null,
            searchableSku,
            searchable_sku,
            jj_prefix: jjPrefix,
            meyer_code: meyerCode,
            keystone_code: keystoneCode,
            quadratec_code: quadratecCode,
            tdot_code: tdotCode,
            t14_code: t14Code,
            premier_code: premierCode,
            partsEngine_code: partsEngineCode,
            tdot_url: tdotUrl,
            keystone_code_site: keystoneCodeSite,
            keystone_ftp_brand: keystoneFtpBrand,

            ctp_code: ctpCode,
            // gentecdirectCode: gentecdirect_code,
            omix_code:
              jjPrefix === "OA" || jjPrefix === "ALY" || jjPrefix === "RR" || jjPrefix === "HVC"
                ? searchable_sku
                : null,
            brand_name: brandName,
            vendors: vendors,
            black_friday_sale: blackFridaySale,
            // manufacturer_code: manufacturerCode,
            image:
              media_gallery_entries && media_gallery_entries.length > 0
                ? `https://www.justjeeps.com/pub/media/catalog/product/${
                    media_gallery_entries[0]?.file || null
                  }`
                : null,
            url_path: url_path ? `https://www.justjeeps.com/${url_path}.html` : null,
          },
        });
        // console.log(`Product with SKU ${sku} created.`);
        createdCount++; // Increment created product counter
      }
    }

    console.log(`Products seeded successfully!! 
    Total products created: ${createdCount}
    Total products updated: ${updatedCount}`);
  } catch (error) {
    console.error("Error seeding data:", error);
  } finally {
    await prisma.$disconnect();
const endTime = Date.now();
const durationMinutes = ((endTime - startTime) / 60000).toFixed(2);
console.log(`Seeding completed in ${durationMinutes} minutes.`);
  }
};

module.exports = seedAllProducts;

seedAllProducts();
