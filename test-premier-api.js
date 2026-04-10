require('dotenv').config();

const PremierService = require('./services/premier');

const sampleItemNumber = process.argv[2];

async function main() {
  const premier = new PremierService();

  console.log('Testing Premier API connection...');
  const connection = await premier.testConnection();
  console.log(JSON.stringify(connection, null, 2));

  if (!connection.success) {
    process.exitCode = 1;
    return;
  }

  if (!sampleItemNumber) {
    console.log('No sample item number provided. Usage: node test-premier-api.js <PREMIER_ITEM_NUMBER>');
    return;
  }

  console.log(`Fetching sample product info for ${sampleItemNumber}...`);
  const productInfo = await premier.getProductInfo(sampleItemNumber);
  console.log(JSON.stringify(productInfo, null, 2));

  if (!productInfo.success) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Premier API test failed:', error.message);
  process.exit(1);
});