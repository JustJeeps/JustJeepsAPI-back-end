const { sendCronReport } = require('./utils/emailService');

console.log('📧 Testing detailed cron report email...\n');

async function testCronReport() {
  const mockResults = [
    { cmd: 'seed-allProducts', success: true, durationMs: 185000, logFile: 'prisma/seeds/logs/seed-allProducts.log' },
    { cmd: 'seed-keystone-ftp-codes', success: true, durationMs: 95000, logFile: 'prisma/seeds/logs/seed-keystone-ftp-codes.log' },
    { cmd: 'seed-quadratec', success: true, durationMs: 245000, logFile: 'prisma/seeds/logs/seed-quadratec.log' },
    { cmd: 'seed-quad-inventory', success: false, durationMs: 480000, logFile: 'prisma/seeds/logs/seed-quad-inventory.log', error: 'Database connection timeout' },
    { cmd: 'seed-omix', success: true, durationMs: 175000, logFile: 'prisma/seeds/logs/seed-omix.log' },
    { cmd: 'seed-omix-inventory', success: true, durationMs: 320000, logFile: 'prisma/seeds/logs/seed-omix-inventory.log' },
    { cmd: 'seed-wheelPros', success: true, durationMs: 425000, logFile: 'prisma/seeds/logs/seed-wheelPros.log' },
    { cmd: 'seed-wheelPros-inventory-csv', success: true, durationMs: 75000, logFile: 'prisma/seeds/logs/seed-wheelPros-inventory-csv.log' },
    { cmd: 'seed-wp-inventory', success: false, durationMs: 35000, logFile: 'prisma/seeds/logs/seed-wp-inventory.log', error: 'File not found: wheelpros_enriched_output.csv' },
    { cmd: 'seed-keystone-ftp2', success: true, durationMs: 210000, logFile: 'prisma/seeds/logs/seed-keystone-ftp2.log' },
    { cmd: 'seed-keystone-ftp-codes', success: true, durationMs: 92000, logFile: 'prisma/seeds/logs/seed-keystone-ftp-codes.log' },
    { cmd: 'seed-roughCountry', success: true, durationMs: 185000, logFile: 'prisma/seeds/logs/seed-roughCountry.log' },
    { cmd: 'seed-tireDiscounter', success: true, durationMs: 150000, logFile: 'prisma/seeds/logs/seed-tireDiscounter.log' },
    { cmd: 'seed-aev', success: true, durationMs: 125000, logFile: 'prisma/seeds/logs/seed-aev.log' },
    { cmd: 'seed-ctp', success: true, durationMs: 95000, logFile: 'prisma/seeds/logs/seed-ctp.log' },
  ];

  console.log('Sending report with mixed success/failure...\n');
  await sendCronReport({
    jobName: 'Daily Vendor Sync (seed-all)',
    success: false,
    exitCode: 1,
    error: '2 script(s) failed',
    duration: '12.45 minutes',
    results: mockResults
  });

  console.log('\n✅ Report email sent!');
  console.log('📬 Check your inbox at: tsantos@justjeeps.com');
}

testCronReport().catch(console.error);
