# Email Notifications Setup

## Overview
The JustJeeps API now supports email notifications for scheduled cron jobs. You'll receive automatic emails when the daily vendor sync completes successfully or fails.

## Configuration

### 1. Add Environment Variables

Add these variables to your `.env` file:

```bash
# SMTP configuration
EMAIL_USER=your-smtp-user@example.com
EMAIL_PASSWORD=your_smtp_password_or_api_key
SMTP_HOST=smtp.example.com
SMTP_PORT=2525
SMTP_SECURE=false
EMAIL_FROM="JustJeeps API <noreply@yourdomain.com>"

# Notification recipient
CRON_NOTIFICATION_EMAIL=tsantos@justjeeps.com
```

For Brevo SMTP relay:

```bash
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_brevo_smtp_login
SMTP_PASSWORD=your_brevo_smtp_key
EMAIL_FROM="JustJeeps API <tsantos@justjeeps.com>"
CRON_NOTIFICATION_EMAIL=tsantos@justjeeps.com
```

Use the generated Brevo SMTP key from Brevo's SMTP settings, not the normal Brevo account login password. A normal account password will authenticate to the Brevo dashboard, but Brevo rejects it for SMTP relay.

Port `2525` is the current production-safe Brevo SMTP port for JustJeeps. Ports `587` and `465` may work locally but can time out from the production host.

Brevo must also trust the sender address in `EMAIL_FROM`. Validate that sender in Brevo, or authenticate the `justjeeps.com` sending domain, before using `tsantos@justjeeps.com` as the From address. If Brevo shows the message as `Error` with "sender is not valid", SMTP submission worked but Brevo rejected the sender after accepting the message.

If outbound SMTP is blocked in production, use Brevo's HTTPS API instead:

```bash
EMAIL_PROVIDER=brevo-api
BREVO_API_KEY=xkeysib-your_real_brevo_api_key
BREVO_FROM="JustJeeps API <tsantos@justjeeps.com>"
CRON_NOTIFICATION_EMAIL=tsantos@justjeeps.com
```

Legacy SendGrid HTTPS API configuration:

```bash
EMAIL_PROVIDER=sendgrid-api
SENDGRID_API_KEY=SG.your_real_sendgrid_api_key
EMAIL_FROM="tsantos@justjeeps.com"
CRON_NOTIFICATION_EMAIL=tsantos@justjeeps.com
```

### 2. Restart the Server

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

To test connectivity without waiting for the cron job:

```bash
npm run test-smtp-connectivity
```

To submit a real provider test email to `CRON_NOTIFICATION_EMAIL`:

```bash
npm run test-email-delivery
```

You can override the recipient for the delivery test:

```bash
node scripts/test-smtp-connectivity.js --send-test-email --to=you@example.com
```

## Troubleshooting

### Emails Not Being Sent

1. **Check environment variables:**
   ```bash
   echo $EMAIL_USER
  echo $EMAIL_PROVIDER
   echo $CRON_NOTIFICATION_EMAIL
   ```

2. **Verify provider credentials:**
  - For SMTP, confirm `EMAIL_USER` / `EMAIL_PASSWORD` or `SMTP_USER` / `SMTP_PASSWORD`
  - For Brevo SMTP, confirm `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASSWORD`
  - For Brevo SMTP/API, confirm the `EMAIL_FROM`/`BREVO_FROM` sender is validated in Brevo or the sending domain is authenticated
  - For Brevo API, confirm `BREVO_API_KEY`
  - For legacy SendGrid API, confirm `SENDGRID_API_KEY`
  - Confirm `EMAIL_FROM` is set for API-based sending

3. **Check console logs:**
   - Look for `⚠️ Email notifications disabled` message
   - Check for any error messages when server starts

4. **Run the connectivity check:**
  ```bash
  npm run test-smtp-connectivity
  ```

### Wrong Recipient

Change the recipient in `.env`:
```bash
CRON_NOTIFICATION_EMAIL=newemail@justjeeps.com
```

## Provider Options

Recommended env vars for custom SMTP:
```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=2525
SMTP_SECURE=false
SMTP_USER=your_username
SMTP_PASSWORD=your_password_or_api_key
EMAIL_FROM="JustJeeps API <noreply@yourdomain.com>"
```

For Brevo SMTP relay:
```bash
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_brevo_smtp_login
SMTP_PASSWORD=your_brevo_smtp_key
EMAIL_FROM="JustJeeps API <tsantos@justjeeps.com>"
```

Use the generated Brevo SMTP key from Brevo's SMTP settings, not the normal Brevo account login password. A normal account password will authenticate to the Brevo dashboard, but Brevo rejects it for SMTP relay.

Port `2525` is the current production-safe Brevo SMTP port for JustJeeps. Ports `587` and `465` may work locally but can time out from the production host.

Brevo also requires the sender address in `EMAIL_FROM` to be validated, or the sender domain to be authenticated. Dashboard errors like "sender is not valid" mean the message reached Brevo but the configured From address is not approved for sending.

If outbound SMTP is blocked in production, use Brevo's HTTPS API instead:
```bash
EMAIL_PROVIDER=brevo-api
BREVO_API_KEY=xkeysib-your_real_brevo_api_key
BREVO_FROM="JustJeeps API <tsantos@justjeeps.com>"
```

Legacy SendGrid HTTPS API configuration:
```bash
EMAIL_PROVIDER=sendgrid-api
SENDGRID_API_KEY=SG.your_real_sendgrid_api_key
EMAIL_FROM="tsantos@justjeeps.com"
```

This path uses HTTPS on port 443 instead of SMTP on ports 465/587.

## Security Notes

- ⚠️ Never commit `.env` file to git
- ✅ Store credentials securely
- ✅ Rotate passwords periodically
