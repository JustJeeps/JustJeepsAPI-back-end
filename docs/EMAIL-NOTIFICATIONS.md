# Email Notifications Setup

## Overview
The JustJeeps API now supports email notifications for scheduled cron jobs. You'll receive automatic emails when the daily vendor sync completes successfully or fails.

## Configuration

### 1. Set up Gmail App Password

To send emails via Gmail, you need to create an **App Password** (not your regular Gmail password):

1. Go to your Google Account: https://myaccount.google.com/
2. Select **Security** > **2-Step Verification** (enable if not already)
3. Scroll to **App passwords**: https://myaccount.google.com/apppasswords
4. Select app: **Mail**
5. Select device: **Other (Custom name)** → Enter "JustJeeps API"
6. Click **Generate**
7. Copy the 16-character password (spaces will be removed automatically)

### 2. Add Environment Variables

Add these variables to your `.env` file:

```bash
# Email Configuration
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_16_char_app_password

# Notification recipient
CRON_NOTIFICATION_EMAIL=tsantos@justjeeps.com
```

### 3. Restart the Server

```bash
npm start
```

You should see:
```
🕐 [CRON] Daily seed-all scheduled for 1:00 AM (Toronto timezone)
📧 [EMAIL] Notifications will be sent to: tsantos@justjeeps.com
```

## Notification Details

### Success Email
- **Subject:** ✅ Daily Vendor Sync (seed-all) - Completed Successfully
- **Content:**
  - Timestamp
  - Duration
  - Success confirmation

### Failure Email
- **Subject:** ❌ Daily Vendor Sync (seed-all) - Failed
- **Content:**
  - Timestamp
  - Exit code
  - Error message
  - Duration
  - Instructions to check server logs

## Current Schedule

- **Job:** `seed-all` (Daily Vendor Sync)
- **Time:** 1:00 AM
- **Timezone:** America/Toronto (EST/EDT)
- **Frequency:** Daily

## Testing Email Notifications

To test the email service without waiting for the cron job:

```javascript
// Add this temporarily to server.js for testing
const { sendCronNotification } = require('./utils/emailService');

// Test success notification
sendCronNotification({
  jobName: 'Test Job',
  success: true,
  duration: '5 minutes'
});

// Test failure notification
sendCronNotification({
  jobName: 'Test Job',
  success: false,
  exitCode: 1,
  error: 'Test error message',
  duration: '2 minutes'
});
```

## Troubleshooting

### Emails Not Being Sent

1. **Check environment variables:**
   ```bash
   echo $EMAIL_USER
   echo $CRON_NOTIFICATION_EMAIL
   ```

2. **Verify App Password:**
   - Use the 16-character password from Google
   - Remove any spaces
   - Don't use your regular Gmail password

3. **Check console logs:**
   - Look for `⚠️ Email notifications disabled` message
   - Check for any error messages when server starts

4. **Gmail Security:**
   - Ensure 2-Step Verification is enabled
   - Make sure "Less secure app access" is OFF (use App Passwords instead)

### Wrong Recipient

Change the recipient in `.env`:
```bash
CRON_NOTIFICATION_EMAIL=newemail@justjeeps.com
```

## Alternative Email Providers

To use a different email provider (e.g., SendGrid, Mailgun, AWS SES):

1. Update `utils/emailService.js`
2. Modify the `createTransporter()` function
3. Update environment variables accordingly

Example for custom SMTP:
```javascript
const transporter = nodemailer.createTransporter({
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});
```

## Security Notes

- ⚠️ Never commit `.env` file to git
- ✅ Always use App Passwords for Gmail
- ✅ Store credentials securely
- ✅ Rotate passwords periodically
