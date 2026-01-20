



require("dotenv").config();
const ftp = require("basic-ftp");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { createWriteStream, statSync } = require("fs");


const FTP_HOST = "ftp.ekeystone.com";
const FTP_USER = "S111945";
const FTP_PASS = "jwd19sle";

const REMOTE_FILES = ["Inventory.csv", "SpecialOrder.csv"];
const LOCAL_DIR = path.join(__dirname, "keystone_files");

// ✅ Helper: Clean fields like ="11317"
function cleanField(value) {
    if (!value) return "";
    return value.replace(/^="|^=|"$|"/g, "").trim();
}

// ✅ Parse CSV
async function parseKeystoneFile(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (row) => {
                results.push({
                    VendorName: row["VendorName"],
                    vcPn: cleanField(row["VCPN"]),
                    vendorCode: cleanField(row["VendorCode"]),
                    partNumber: cleanField(row["PartNumber"]),
                    manufacturerPartNo: cleanField(row["ManufacturerPartNo"]),
                    cost: parseFloat(row["Cost"]),
                    totalQty: parseInt(row["TotalQty"], 10)
                });
            })
            .on("end", () => {
                console.log(`✅ Parsed ${results.length} records from ${path.basename(filePath)}`);
                console.log("🔎 Sample data:", results.slice(0, 5));
                resolve(results);
            })
            .on("error", reject);
    });
}

// ✅ Helper: Download with retries
async function downloadFile(remoteFile, localPath) {
    let attempts = 0;
    while (attempts < 5) { // allow more retries
        const client = new ftp.Client();
        client.ftp.verbose = true;
        client.ftp.socketTimeout = 180000; // 3 min
        client.prepareTransfer = ftp.enterPassiveModeIPv4;

        try {
            // check if partial file exists
            let startAt = 0;
            if (fs.existsSync(localPath)) {
                startAt = statSync(localPath).size;
                console.log(`⏩ Resuming ${remoteFile} from byte ${startAt}`);
            }

            // connect
            console.log("🔗 Connecting to Keystone FTP...");
            await client.access({
                host: FTP_HOST,
                port: 990,
                user: FTP_USER,
                password: FTP_PASS,
                secure: "implicit",
                secureOptions: { rejectUnauthorized: false },
                timeout: 180000
            });

            // open write stream in append mode if resuming
            const writeStream = createWriteStream(localPath, { flags: startAt > 0 ? "a" : "w" });

            console.log(`📥 Downloading ${remoteFile} (Attempt ${attempts + 1})...`);
            await client.download(writeStream, remoteFile, startAt); // ✅ supports resume from last byte

            console.log(`✅ Successfully downloaded (complete): ${localPath}`);
            client.close();
            return true;

        } catch (err) {
            console.warn(`⚠️ Failed during chunked download of ${remoteFile}, retrying... (${attempts + 1}/5)`, err.message);
            attempts++;
            client.close();
        }
    }
    throw new Error(`❌ Could not fully download ${remoteFile} after 5 attempts`);
}


// ✅ Main
async function downloadAndParse() {
    if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR);
    const parsedResults = [];

    for (const file of REMOTE_FILES) {
        const localPath = path.join(LOCAL_DIR, file);
        await downloadFile(file, localPath); // ✅ retry-safe download
        const fileData = await parseKeystoneFile(localPath);
        parsedResults.push({ file, data: fileData });
    }

    console.log("🎯 All files processed successfully.");
    return parsedResults;
}

// ✅ Run everything
downloadAndParse().then(result => {
    console.log("📂 Parsed Keystone Data Ready for Seeding!");
    console.dir(result.slice(0, 1), { depth: null }); // only preview Inventory data
});

module.exports = downloadAndParse;
