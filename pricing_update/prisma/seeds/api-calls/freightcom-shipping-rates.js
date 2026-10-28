

const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Parser } = require("json2csv");

const prisma = new PrismaClient();

const FREIGHTCOM_API_KEY = process.env.FREIGHTCOM_API_KEY;
const FREIGHTCOM_RATE_URL = "https://customer-external-api.ssd-test.freightcom.com/rate";

const DESTINATIONS = [
  { label: "Toronto", city: "Toronto", region: "ON", postal_code: "M8V 1X9" },
  { label: "Vancouver", city: "Vancouver", region: "BC", postal_code: "V5N 1X6" },
  { label: "Gatineau", city: "Gatineau", region: "QC", postal_code: "J8Y 1X9" },
  { label: "Calgary", city: "Calgary", region: "AB", postal_code: "T2Y 2W3" }
];

const ORIGIN = {
  name: "Just Jeeps Warehouse",
  address: {
    address_line_1: "128 Oakdale Road",
    city: "North York",
    region: "ON",
    country: "CA",
    postal_code: "M3N 1V9"
  },
  phone_number: {
    number: "5554447777",
    extension: "123"
  }
};

const SERVICES = [
  "ei8AJgRFI3Xslob8UmFawLq71jhlKyZX.standard",
  "fedex.economy",
  "fedex.standard",
  "minimax.standard",
  "QzGk6Gz9BPcw0v7zsJcIaTAAXd6X7732.standard",
  "speedy.standard",
  "tstapi.intermodal",
  "tstapi.standard",
  "Zs8TafpKGZ0fx9utJ42E4ZFyLtoRUmzE.standard",
  "1lFVuiEgI85Be3BmNH9Jc8QKe5DEDVs0.standard",
  "billatransport-203.standard",
  "hiway.standard",
  "manitoulintransport-440.standard",
  "fleet-optics.standard",
  "gardewine.standard",
  "pI5W4sEjmM5Cic50XfWBK75dUq4YbtC7.standard",
  "polarisdirect.standard",
  "polaristransportation-188.standard",
  "uYzMOpUNF91z1DjkFfPaiwfC42tY4dpy.standard",
  "ab-courier-ltl.ltl-direct",
  "ab-courier-ltl.ltl-rush",
  "ab-courier-ltl.ltl-sameday",
  "B6lmGiW6bT5uYz0ceJwoqduC0QRf51cr.standard",
  "customcourierco-469.standard",
  "nishantransportinc-423.standard",
  "ups.3day-select",
  "ups.expedited",
  "ups.express",
  "ups.express-early",
  "ups.express-saver",
  "ups.ground",
  "ups.standard",
  "ups.worldwide-expedited",
  "ups.worldwide-express",
  "ups.worldwide-express-plus",
  "ups.worldwide-express-saver",
  "6XTleMYOSAZrdGo5dkg0AB2FS3E35oMF.standard",
  "abcourier-480.standard",
  "airpro-255.standard",
  "AMBNd2Qj747jl1GrYu5v3L5TRTaXgV2p.standard",
  "dayrosscommerce-266.standard",
  "gls.ground",
  "LfT69HBpfJrjS9wv0tkFVylVxcMwWIVt.standard",
  "polarisweb.standard",
  "2ya9w4n9GgNbqWlBgKcWro3WYkm0SI2d.standard",
  "bbWZeWwm92b0eyQBYnRNT5PUJb7vslCY.standard",
  "boxknight.next-day",
  "boxknight.sameday",
  "checkercourier-276.standard",
  "dayrossrlc-132.standard",
  "gsm.air-skip",
  "gsm.air-skip-eco",
  "gsm.air-skip-plus",
  "gsm.armed-secure-air",
  "gsm.armed-secure-ground",
  "gsm.ground",
  "gsm.secure-air",
  "gsm.secure-ground",
  "gsm.zone-skip",
  "gsm.zone-skip-plus",
  "one.standard",
  "spring-gds.spring-direct",
  "spring-gds.spring-gateway-parcel",
  "spring-gds.spring-packet-plus",
  "spring-gds.spring-packet-tracked",
  "spring-gds.spring-packet-untracked",
  "abffreight-455.standard",
  "w2oXoP88bl44DA3Y4hft8dZoLFDp3KFX.standard",
  "swyft.nextday",
  "swyft.sameday",
  "usps.first-class",
  "usps.ground-advantage",
  "usps.parcel-select-ground",
  "usps.priority-mail",
  "usps.priority-mail-express",
  "yrc.accelerated",
  "yrc.freight-canada-to-us",
  "yrc.freight-dedicated-equipment",
  "yrc.standard",
  "yrc.time-critical-by-5pm",
  "yrc.time-critical-by-afternoon",
  "yrc.time-critical-fastest-ground",
  "yrc.time-critical-hour-window",
  "ancortransportltd-228.standard",
  "maritime.dry",
  "maritime.frozen",
  "maritime.heat",
  "morneau.standard",
  "purolatorfreight.standard",
  "TXbrc3AuAEXSJ9uQnT40gRG0zk41qTml.standard",
  "bgxtransportation-361.standard",
  "fedex-courier.2-day",
  "fedex-courier.2-day-a-m",
  "fedex-courier.express-saver",
  "fedex-courier.first-overnight",
  "fedex-courier.ground",
  "fedex-courier.international-connect-plus",
  "fedex-courier.international-economy",
  "fedex-courier.international-ground",
  "fedex-courier.international-priority",
  "fedex-courier.international-priority-express",
  "fedex-courier.overnight",
  "fedex-courier.priority-overnight",
  "fedex-courier.same-day",
  "gls-freight.ground",
  "KqwXT5YZbXOvt0PXziMUxkj3J6V1pTsQ.standard",
  "martinroytransport-310.standard",
  "wuPUFbL2xJpG1vd4jHDl0vaXiXZ99WO4.standard",
  "alldaystransportltd-449.standard",
  "centraltransport-427.standard",
  "dhlcanada-230.standard",
  "gMS33dZBLDmtyw0ileP8b0wxytNPUNEe.standard",
  "midland.econoline",
  "midland.reefer",
  "midland.standard",
  "sameday.2-man-delivery-to-entrance",
  "sameday.2-man-delivery-to-room-of-choice",
  "sameday.2-man-delivery-to-room-of-choice-with-debris-removal",
  "sameday.dayr-ecom-urgent-pac",
  "sameday.delivery-to-entrance",
  "sameday.delivery-to-room-of-choice",
  "sameday.delivery-to-room-of-choice-with-debris-removal",
  "sameday.ground-daynross-road",
  "sameday.next-day-before-5pm",
  "sameday.next-day-before-9am",
  "sameday.next-day-delivery-before-noon",
  "wce.standard",
  "XiX2uCQlUYTCn4Mi5z3APT4Mi2Xn2x3a.standard",
  "atlantistransport-347.standard",
  "ab-courier.canada-1030am",
  "ab-courier.canada-930am",
  "ab-courier.canada-ground",
  "ab-courier.canada-overnight",
  "ab-courier.direct",
  "ab-courier.four-hour",
  "ab-courier.rush",
  "ab-courier.sameday",
  "apexmotorexpress-258.standard",
  "exceltransportation-328.standard",
  "fastfrate.express",
  "fastfrate.standard",
  "kindersley-courier.standard",
  "mopallet.standard",
  "oGcc501ByfjEkKDLI2lgD4GJDu63iYPy.standard",
  "6C7fNpnT2ai5XWEGEgAsVxSdKlKfIFI2.standard",
  "courrierplus-494.standard",
  "csatransportation-191.standard",
  "fedexexpress-272.standard",
  "kindersleytransport-263.standard",
  "Mg5oX7RWPCrENCdFkqaijO3NI0qKLFPt.standard",
  "apps.intermodal",
  "apps.standard",
  "ajWA9sU9dV6U6oSB5GrokBvlzfV2RRf7.standard",
  "Fqrdds8xTJcw2gopMEKjgdNR0jTkxxVm.standard",
  "nationex.standard",
  "purolatorfreight.standard",
  "tforcefreight.tforcefreight-guarnteed",
  "tforcefreight.tforcefreight-ltl",
  "tforcefreight.tforcefreight-standard",
  "VwSa0UuckhcLkEzVoCSkhPJoTygfzeIk.standard",
  "7yH8UyFP478mgqQwXJRzFXbK9ge7zV3C.standard",
  "hnrtransport-309.standard",
  "dhlexpress.domestic-express",
  "dhlexpress.domestic-express1030am",
  "dhlexpress.domestic-express9am",
  "dhlexpress.economy-select",
  "dhlexpress.express-easy",
  "dhlexpress.express-worldwide",
  "dhlexpress.express1030am",
  "dhlexpress.express12pm",
  "dhlexpress.express9am",
  "dayton-freight.standard",
  "newpennmotorexpress-445.standard",
  "speedytransport-153.standard",
  "amatransinc-251.standard",
  "dj9Lv4FUhkBIG7tdKiWh4n3U2lP2Drc5.standard",
  "qM4cPFVXO20tNUz8fuU2bZCd6s0a6oKE.standard",
  "V44U22d1DwvXrhpvW7UtPrZ4GQQ6x6Hb.standard",
  "accordtransportation-176.standard",
  "6D24l95xtm4jFC550GYo0tLEBrjgavVS.standard",
  "allspeed-432.standard",
  "americanexpeditingco-241.standard",
  "CQlGbL25o2xOrLL7TkCigKSUjOjQ1Bbh.standard",
  "loomis-express.express-0900",
  "loomis-express.express-1200",
  "loomis-express.express-1800",
  "loomis-express.ground",
  "xpo.standard",
  "2vlSmNNDnF6OWQFjUTFPlwLpTv0RkgXp.standard",
  "dhl-ecomm.packet-international",
  "dhl-ecomm.parcel-expedited",
  "dhl-ecomm.parcel-expedited-max",
  "dhl-ecomm.parcel-ground",
  "dhl-ecomm.parcel-international-direct",
  "dhl-ecomm.parcel-international-direct-priority",
  "dhl-ecomm.parcel-international-direct-standard",
  "dhl-ecomm.parcel-international-standard",
  "gls-us.am-select-8a-12p",
  "gls-us.early-priority-overnight",
  "gls-us.early-saturday-delivery",
  "gls-us.evening-select-4p-8p",
  "gls-us.gls-ground",
  "gls-us.noon-priority-overnight-sds\u2013saturday-delivery",
  "gls-us.pm-select-12p-4p",
  "gls-us.priority-overnight",
  "gls-us.saturday-delivery",
  "6AS1YHCOu0JmUMnb0kEHBAS1blnvdi3C.standard",
  "commandtransportation-214.standard",
  "kindersley.expedited",
  "kindersley.intermodal",
  "kindersley.standard",
  "peglobal-511.standard",
  "vitran.maxx",
  "vitran.priority",
  "vitran.regular",
  "c5itKPJ6v6s4cmHEhjMDbbp9XD5lKoPR.standard",
  "dayrosscdn-133.standard",
  "glsfreight-186.standard",
  "xpologistics-265.standard",
  "caledoncouriers-294.standard",
  "4TBSrW3F8aUzohICK0A0XH2mk25Aipdx.standard",
  "a10cD2MfJjiOCcRejjgv3cHMyRcRBhE3.standard",
  "am0cHEYPS0pZbXDbVXUM6opDv3c4YyxP.standard",
  "apex.standard",
  "cassidystransferandstorageltd-244.standard",
  "comox.standard",
  "maritimeontario-267.standard",
  "newpenn.standard",
  "purolatorcourier.express",
  "purolatorcourier.express-box",
  "purolatorcourier.express-box-international",
  "purolatorcourier.express-box1030am",
  "purolatorcourier.express-box9am",
  "purolatorcourier.express-boxUS",
  "purolatorcourier.express-envelope",
  "purolatorcourier.express-envelope-international",
  "purolatorcourier.express-envelope-us",
  "purolatorcourier.express-envelope1030am",
  "purolatorcourier.express-envelope9am",
  "purolatorcourier.express-international",
  "purolatorcourier.express-pack",
  "purolatorcourier.express-pack-international",
  "purolatorcourier.express-pack-us",
  "purolatorcourier.express-pack1030am",
  "purolatorcourier.express-pack9am",
  "purolatorcourier.express-us",
  "purolatorcourier.express-us-1030am",
  "purolatorcourier.express-us-9am",
  "purolatorcourier.express-us-box1030AM",
  "purolatorcourier.express-us-box9AM",
  "purolatorcourier.express-us-envelope1030am",
  "purolatorcourier.express-us-envelope9am",
  "purolatorcourier.express-us-pack1030am",
  "purolatorcourier.express-us-pack9am",
  "purolatorcourier.express1030AM",
  "purolatorcourier.express9AM",
  "purolatorcourier.ground",
  "purolatorcourier.ground-us",
  "purolatorcourier.ground",
  "mBbc7RwNE6CPvx22XiDZ50kdsC2fLNEF.standard",
  "saia.standard",
  "transkid.standard",
  "ics.ground",
  "ics.next-day",
  "excel-transport.standard",
  "gY2Ah4O53ACmkb6D75rHLg6eMfzpsIpw.standard",
  "37SyVWjCgJxqehNHTdBaFhz1MQxKK0Vd.standard",
  "e5966ZlRusUUM61sXUM1QQx0Td17iIan.standard",
  "fedexground-426.standard",
  "ki3V5cuenABba7343oJNBTgnCiNwKEYN.standard",
  "YlhNxO31X2UtvtKauwVLdIo4skgYEtDi.standard",
  "yrcfreight-330.standard",
  "canuckbrotherstransportinc-325.standard",
  "daynross.cs",
  "daynross.domestic-standard",
  "daynross.transborder-standard",
  "nin.next-day",
  "nin.same-day",
  "canadapost.domestic",
  "canadapost.expedited-parcel",
  "canadapost.international",
  "canadapost.international-parcel-air",
  "canadapost.international-parcel-surface",
  "canadapost.priority",
  "canadapost.priority-ww-envelope-international",
  "canadapost.priority-ww-pak-international",
  "canadapost.priority-ww-parcel-international",
  "canadapost.regular-parcel",
  "canadapost.small-packet-international-air",
  "canadapost.small-packet-international-surface",
  "canadapost.tracked-packet-international",
  "canadapost.xpresspost",
  "canadapost.xpresspost-international",
  "rollsright.standard",
  "FzXhDtSYDgMYP97Zi28GgU4j8QNXBllS.standard",
  "h9d2M32kjQDeB0GldPN0AMYvhuEXI45c.standard",
  "midlandtransport-437.standard",
  "overland.standard",
  "csa.standard",
  "TKzEkXVCaQIkGU0SqHyix6Lujv1YiCaR.standard",
  "vankam.standard",
  "LtViz90ze09z34gcXmBbnFhSSqvvO6h5.standard",
  "allmodes-147.standard",
  "anq7q2st2UWtnj2WPWqXtgIgaUa4AZF4.standard",
  "intelcom.standard",
  "LfuLpu4OaMgNiVnBFYbNUXxiAyY66z3m.standard",
  "AbqB0FuehDpOtTxHzhhEvBs8CRJ44Z2I.standard",
  "albrighttruckinginc-454.standard",
  "bettertrucks.ddu",
  "bettertrucks.express",
  "bettertrucks.next_day",
  "bettertrucks.same_day",
  "canpar.ground",
  "canpar.international",
  "canpar.overnight",
  "canpar.overnight-letter",
  "canpar.overnight-pak",
  "canpar.select",
  "canpar.select-letter",
  "canpar.select-pak",
  "cct.expedited",
  "cct.intermodal",
  "frontline.standard",
  "kindersley-freight.domestic-expedited",
  "kindersley-freight.domestic-rail",
  "kindersley-freight.domestic-road",
  "kindersley-freight.transborder",
  "purolatorfreight-151.standard",
  "actionforcetransportltd-363.standard",
  "swiftdeliverysystems-268.standard",
  "upscourier-162.standard",
  "reddaway.guaranteed-3pm",
  "reddaway.guaranteed-9am",
  "reddaway.guaranteed-noon",
  "reddaway.guaranteed-weekend",
  "reddaway.guarenteed-9am",
  "reddaway.guarenteed-noon",
  "reddaway.interline",
  "reddaway.multi-hour-window",
  "reddaway.regional-delivery",
  "reddaway.single-hour-window",
  "reddaway.single-or-multi-day",
  "reddaway.standard",
  "fedexfreight-154.standard",
  "holland.guaranteed-330-pm",
  "holland.guaranteed-9-am",
  "holland.guaranteed-day",
  "holland.guaranteed-hour",
  "holland.guaranteed-multi-hour",
  "holland.guaranteed-noon",
  "holland.guaranteed-weekend",
  "holland.inter-regional",
  "holland.interline",
  "holland.regional",
  "IHyzcZOWT205W8bBO3vydH0TMzC8xPRB.standard",
  "IQ1rjQyWY8EflOBKVyqGM1syqer1O65V.standard",
  "KQfppq3g1UUR3BabBSUvQko4MWDUPnul.standard",
  "moto.standard",
  "c19h151C0I4Sdnp3Mqt0jRLxjTcNtksA.standard"


];


// [
//   "canpar.ground", "canpar.select", "canpar.select-pak",
//   "fedex.economy", "fedex.standard",
//   "fedex-courier.ground", "fedex-courier.same-day",
//   "fedexground-426.standard", "fedexfreight-154.standard",
//   "purolatorcourier.ground", "purolatorfreight-151.standard", "purolatorfreight.standard",
//   "ups.ground", "ups.standard", "ups.3day-select",
//   "gls.ground", "gls-freight.ground",
//   "daynross.domestic-standard", "daynross.cs", "dayrosscdn-133.standard",
//   "sameday.ground-daynross-road", "dayrossrlc-132.standard", "dayrosscommerce-266.standard",
//   "sameday.2-man-delivery-to-entrance", "sameday.2-man-delivery-to-room-of-choice",
//   "sameday.2-man-delivery-to-room-of-choice-with-debris-removal", "sameday.dayr-ecom-urgent-pac",
//   "sameday.delivery-to-entrance", "sameday.delivery-to-room-of-choice",
//   "sameday.delivery-to-room-of-choice-with-debris-removal",
//   "sameday.next-day-before-5pm", "sameday.next-day-before-9am",
//   "sameday.next-day-delivery-before-noon",
//   "mopallet.standard", "maritimeontario-267.standard",
//   "apexmotorexpress-258.standard", "apex.standard",
//   "FzXhDtSYDgMYP97Zi28GgU4j8QNXBllS.standard"
// ];



const fetchFreightcomRates = async () => {
  const testOnly = false;
  const runOnlyPalletEligible = false; // Toggle this to false to run for all products

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      brand_name: { in: [ 
        "Rough Country",
      ]},
      sku: {
        not: {
          endsWith: "-"
        }
      },
      // Only products with weight but no dimensions
      weight: {
        not: null,
        gt: 0
      },
      OR: [
        { length: null },
        { length: 0 },
        { width: null },
        { width: 0 },
        { height: null },
        { height: 0 }
      ]
    },
    select: {
      sku: true,
      brand_name: true,
      meyer_code: true,
      price: true,
      weight: true,
      length: true,
      width: true,
      height: true
    },
    ...(testOnly && { take: 100 })
  });

  console.log(`🔢 Total products fetched: ${products.length}`);
  // console.log("🧪 Checking how many products qualify as pallet...");



  let productsToRun;

  if (runOnlyPalletEligible) {
    productsToRun = products.filter(p => {
      let { weight, length, width, height, sku, brand_name } = p;
      if (!weight) return false; // Skip if no weight at all
    
      // For pallet eligibility, if we have dimensions, calculate dimWeight
      // If we don't have dimensions, use weight threshold only
      if (length && width && height) {
        const dimWeight = (length * width * height) / 139;
        const qualifies = dimWeight > 139 || weight > 150;
        
        if (qualifies) {
          console.log(`✅ ${sku} qualifies (Weight: ${weight} | DimWeight: ${dimWeight.toFixed(2)})`);
        } else {
          console.log(`❌ ${sku} skipped (Weight: ${weight} | DimWeight: ${dimWeight.toFixed(2)})`);
        }
        
        return qualifies;
      } else {
        // Weight-only products: use weight threshold only
        const qualifies = weight > 150;
        
        if (qualifies) {
          console.log(`✅ ${sku} qualifies (Weight-only: ${weight} lbs > 150 threshold)`);
        } else {
          console.log(`❌ ${sku} skipped (Weight-only: ${weight} lbs ≤ 150 threshold)`);
        }
        
        return qualifies;
      }
    });
    

    console.log(`🚚 Filtered to ${productsToRun.length} pallet-eligible products (dimWeight > 139 && weight > 150)`);
  } else {
    productsToRun = products;
  }

  console.log(`📦 Total SKUs that will be processed: ${productsToRun.length}`);

  const today = new Date();
  const expected_ship_date = {
    year: today.getFullYear(),
    month: today.getMonth() + 2,
    day: today.getDate() + 1
  };

  const results = [];

  function savePartialCSV() {
    if (results.length > 0) {
      const fields = [
        "Meyer_Code", "SKU", "Brand", "Price", "Length", "Width", "Height", "Weight",
        ...DESTINATIONS.flatMap(dest => [
          `${dest.label} best price`, `${dest.label} best carrier`, `${dest.label} all rates`
        ])
      ];
      const parser = new Parser({ fields });
      const csv = parser.parse(results);
      const filePath = path.join(__dirname, "freightcom_shipping_rates_partial.csv");
      fs.writeFileSync(filePath, csv);
      console.log(`💾 Partial CSV saved at: ${filePath}`);
    } else {
      console.log("⚠️ No results to save.");
    }
  }

  process.on("SIGINT", () => {
    console.log("\n🛑 Process interrupted by user. Saving partial results...");
    savePartialCSV();
    process.exit();
  });

  
for (const product of productsToRun) {
  let { sku, brand_name, meyer_code, price, weight, length, width, height } = product;

  // Skip if no weight at all
  if (!weight) {
    console.warn(`⚠️ Missing weight for SKU: ${product.sku}, skipping...`);
    continue;
  }

  // Check if we have complete dimensions
  const hasCompleteDimensions = length && width && height;
  
  if (hasCompleteDimensions) {
    const dimWeight = (length * width * height) / 139;
    console.log(`📦 ${sku}: Weight = ${weight} lbs, Dim Weight = ${dimWeight.toFixed(2)} → Running both Package and Pallet`);
  } else {
    console.log(`⚖️ ${sku}: Weight-only = ${weight} lbs (no dimensions) → Running both Package (with estimated size) and Pallet`);
  }

  const row = {
    Meyer_Code: meyer_code || sku,
    SKU: sku,
    Brand: brand_name,
    Price: price.toFixed(2),
    Length: length || 'N/A',
    Width: width || 'N/A',
    Height: height || 'N/A',
    Weight: weight
  };

    // Dynamic freight class calculator
function calculateFreightClass(length, width, height, weight) {
  // If we don't have dimensions, use weight-based classification
  if (!length || !width || !height) {
    // Default freight classes based on weight ranges for unknown dimensions
    if (weight > 300) return "500";
    if (weight > 200) return "400";
    if (weight > 150) return "300";
    if (weight > 100) return "250";
    if (weight > 50) return "200";
    return "175";
  }
  
  const volumeCubicFeet = (length * width * height) / 1728;
  const density = weight / volumeCubicFeet;

  if (density > 50) return "50";
  if (density > 35) return "55";
  if (density > 30) return "60";
  if (density > 22.5) return "65";
  if (density > 15) return "70";
  if (density > 13.5) return "77.5";
  if (density > 12) return "85";
  if (density > 10.5) return "92.5";
  if (density > 9) return "100";
  if (density > 8) return "110";
  if (density > 7) return "125";
  if (density > 6) return "150";
  if (density > 5) return "175";
  if (density > 4) return "200";
  if (density > 3) return "250";
  if (density > 2) return "300";
  if (density > 1) return "400";
  return "500";
}

const freightClass = calculateFreightClass(length, width, height, weight);

if (hasCompleteDimensions) {
  console.log(`Freight Class for ${sku}: ${freightClass} (calculated from density)`);
} else {
  console.log(`Freight Class for ${sku}: ${freightClass} (weight-based estimate)`);
}

  for (const dest of DESTINATIONS) {
    const bestRates = {};

    // Always try both shipping modes - let the API decide what works
    for (const mode of ["package", "pallet"]) {
      console.log(`➡️  Checking ${sku} to ${dest.label} as ${mode.toUpperCase()}`);

      const packaging_properties =
        mode === "pallet"
          ? {
              pallet_type: "ltl",
              pallets: [
                {
                  measurements: {
                    weight: { unit: "lb", value: weight },
                    // For pallet LTL, use standard pallet size when dimensions unknown
                    cuboid: { 
                      unit: "in", 
                      l: length || 48, // Standard pallet length
                      w: width || 40,  // Standard pallet width  
                      h: height || 48  // Reasonable height for LTL
                    }
                  },
                  description: hasCompleteDimensions ? "Pallet with exact dimensions" : "Pallet (weight-only, standard pallet size)",
                  freight_class: freightClass
                }
              ]
            }
          : {
              packages: [
                {
                  measurements: {
                    weight: { unit: "lb", value: weight },
                    // For package shipping, use reasonable defaults when dimensions unknown
                    // Based on weight to be more realistic
                    cuboid: { 
                      unit: "in", 
                      l: length || (weight <= 5 ? 8 : weight <= 15 ? 12 : weight <= 30 ? 16 : 20),
                      w: width || (weight <= 5 ? 6 : weight <= 15 ? 8 : weight <= 30 ? 12 : 16), 
                      h: height || (weight <= 5 ? 4 : weight <= 15 ? 6 : weight <= 30 ? 8 : 12)
                    }
                  },
                  description: hasCompleteDimensions ? "Product package" : "Package (weight-only, estimated size)"
                }
              ]
            };

      const payload = {
        services: SERVICES,
        details: {
          origin: ORIGIN,
          destination: {
            name: `Just Jeeps - ${dest.label}`,
            address: {
              address_line_1: "1234 Some St.",
              city: dest.city,
              region: dest.region,
              country: "CA",
              postal_code: dest.postal_code
            },
            ready_at: { hour: 9, minute: 0 },
            ready_until: { hour: 17, minute: 0 },
            signature_requirement: "required"
          },
          expected_ship_date,
          packaging_type: mode,
          packaging_properties
        }
      };

      try {

        // console.log(`📤 PAYLOAD for ${sku} to ${dest.label} as ${mode.toUpperCase()}:`);
        // console.dir(payload, { depth: null });


        const rateRes = await axios.post(FREIGHTCOM_RATE_URL, payload, {
          headers: {
            Authorization: FREIGHTCOM_API_KEY,
            "Content-Type": "application/json"
          }
        });

        await new Promise((r) => setTimeout(r, 3000));

        const finalRes = await axios.get(`${FREIGHTCOM_RATE_URL}/${rateRes.data.request_id}`, {
          headers: { Authorization: FREIGHTCOM_API_KEY }
        });

        // console.log(`📥 FULL RATE RESPONSE for ${sku} to ${dest.label} as ${mode.toUpperCase()}:`);
        // console.dir(finalRes.data, { depth: null });


        const rates = finalRes.data.rates || [];
        if (rates.length === 0) {
          console.warn(`⚠️ No rates returned for ${sku} to ${dest.label} as ${mode}`);
          continue;
        }

        const sortedRates = rates
        .filter(r => r.total && !isNaN(parseFloat(r.total.value)))
        .sort((a, b) => parseFloat(a.total.value) - parseFloat(b.total.value));
    
      if (sortedRates.length === 0) {
        console.warn(`⚠️ All returned rates were invalid for ${sku} to ${dest.label} as ${mode}`);
        continue;
      }
    
      const best = sortedRates[0];

      console.log("✅ BEST SELECTED:", sortedRates[0].carrier_name, (parseFloat(sortedRates[0].total.value) / 100).toFixed(2));

    
      bestRates[mode] = {
        best,
        all: sortedRates
      };
    
        // const sortedRates = rates.sort((a, b) => parseFloat(a.total.value) - parseFloat(b.total.value));
        // bestRates[mode] = {
        //   best: sortedRates[0],
        //   all: rates
        // };

        console.log(`✅ ${sku} ${mode} to ${dest.label}: Best = $${(parseFloat(sortedRates[0].total.value) / 100).toFixed(2)} - ${sortedRates[0].carrier_name}`);

      } catch (err) {
        console.error(`❌ Error fetching rate for ${sku} to ${dest.label} as ${mode}: ${err.message}`);
      }
    }

    // Compare package vs pallet
    let selectedRate;
    if (bestRates.package && bestRates.pallet) {
      const pkg = parseFloat(bestRates.package.best.total.value);
      const pal = parseFloat(bestRates.pallet.best.total.value);
      selectedRate = pkg <= pal ? bestRates.package : bestRates.pallet;
    } else {
      selectedRate = bestRates.package || bestRates.pallet;
    }

    if (selectedRate) {
      row[`${dest.label} best price`] = `$${(parseFloat(selectedRate.best.total.value) / 100).toFixed(2)}`;
      row[`${dest.label} best carrier`] = `${selectedRate.best.carrier_name} - ${selectedRate.best.service_name}`;
      row[`${dest.label} all rates`] = selectedRate.all
        .map(rate => rate.carrier_name + " - " + rate.service_name + " - $" + (parseFloat(rate.total.value) / 100).toFixed(2))
        .join("\\n");
    } else {
      row[`${dest.label} best price`] = "N/A";
      row[`${dest.label} best carrier`] = "N/A";
      row[`${dest.label} all rates`] = "N/A";
    }
  }

  results.push(row);
}


  const fields = [
    "Meyer_Code", "SKU", "Brand", "Price", "Length", "Width", "Height", "Weight",
    ...DESTINATIONS.flatMap(dest => [
      `${dest.label} best price`,
      `${dest.label} best carrier`,
      `${dest.label} all rates`
    ])
  ];
  

  const parser = new Parser({ fields });
  const csv = parser.parse(results);
  const filePath = path.join(__dirname, "freightcom_shipping_rates.csv");
  fs.writeFileSync(filePath, csv);

  console.log(`✅ CSV file saved at: ${filePath}`);
};

fetchFreightcomRates(); // ✅ This runs the function



