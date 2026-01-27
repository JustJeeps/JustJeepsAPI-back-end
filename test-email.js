const { sendCronNotification } = require('./utils/emailService');

console.log('📧 Testing email notification system...\n');

async function testEmailNotifications() {
  // Test 1: Success notification
  console.log('1️⃣ Sending SUCCESS notification...');
  await sendCronNotification({
    jobName: 'Test Job - Success',
    success: true,
    duration: '3.5 minutes'
  });

  console.log('\n⏳ Waiting 2 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Test 2: Failure notification
  console.log('2️⃣ Sending FAILURE notification...');
  await sendCronNotification({
    jobName: 'Test Job - Failure',
    success: false,
    exitCode: 1,
    error: 'Test error: Database connection timeout',
    duration: '1.2 minutes'
  });

  console.log('\n✅ Email test completed!');
  console.log('📬 Check your inbox at:', process.env.CRON_NOTIFICATION_EMAIL || 'tsantos@justjeeps.com');
  console.log('\n💡 Note: If you don\'t receive emails, check:');
  console.log('   - EMAIL_USER and EMAIL_PASSWORD are set in .env');
  console.log('   - Gmail App Password is correct (16 characters)');
  console.log('   - Check spam folder');
}

testEmailNotifications().catch(console.error);
