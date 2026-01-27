const nodemailer = require('nodemailer');
require('dotenv').config();

/**
 * Email Service for sending notifications
 * Supports Gmail SMTP (can be configured for other providers)
 */

// Create reusable transporter
const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER || process.env.GMAIL_USER,
      pass: process.env.EMAIL_PASSWORD || process.env.GMAIL_APP_PASSWORD
    }
  });
};

/**
 * Send email notification
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text content
 * @param {string} options.html - HTML content (optional)
 */
async function sendEmail({ to, subject, text, html }) {
  try {
    // Skip if email credentials are not configured
    if (!process.env.EMAIL_USER && !process.env.GMAIL_USER) {
      console.log('⚠️  Email notifications disabled - EMAIL_USER not configured');
      return { success: false, message: 'Email not configured' };
    }

    const transporter = createTransporter();
    
    const mailOptions = {
      from: `"JustJeeps API" <${process.env.EMAIL_USER || process.env.GMAIL_USER}>`,
      to,
      subject,
      text,
      html: html || text
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Failed to send email:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send cron job completion notification
 * @param {Object} params
 * @param {string} params.jobName - Name of the cron job
 * @param {boolean} params.success - Whether the job succeeded
 * @param {number} params.exitCode - Exit code (if failed)
 * @param {string} params.error - Error message (if failed)
 * @param {string} params.duration - Job duration
 */
async function sendCronNotification({ jobName, success, exitCode, error, duration }) {
  const recipient = process.env.CRON_NOTIFICATION_EMAIL || 'tsantos@justjeeps.com';
  
  const subject = success 
    ? `✅ ${jobName} - Completed Successfully`
    : `❌ ${jobName} - Failed`;

  const timestamp = new Date().toLocaleString('en-US', { 
    timeZone: 'America/Toronto',
    dateStyle: 'full',
    timeStyle: 'long'
  });

  const text = success
    ? `The scheduled job "${jobName}" completed successfully.\n\n` +
      `Timestamp: ${timestamp}\n` +
      `Duration: ${duration || 'N/A'}\n\n` +
      `All vendor data has been synchronized.`
    : `The scheduled job "${jobName}" failed.\n\n` +
      `Timestamp: ${timestamp}\n` +
      `Exit Code: ${exitCode || 'N/A'}\n` +
      `Error: ${error || 'Unknown error'}\n\n` +
      `Please check the server logs for more details.`;

  const html = success
    ? `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #52c41a;">✅ Job Completed Successfully</h2>
        <div style="background: #f6ffed; border: 1px solid #b7eb8f; padding: 20px; border-radius: 4px;">
          <h3>${jobName}</h3>
          <p><strong>Status:</strong> <span style="color: #52c41a;">Success</span></p>
          <p><strong>Timestamp:</strong> ${timestamp}</p>
          <p><strong>Duration:</strong> ${duration || 'N/A'}</p>
        </div>
        <p style="margin-top: 20px;">All vendor data has been synchronized successfully.</p>
      </div>
    `
    : `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #ff4d4f;">❌ Job Failed</h2>
        <div style="background: #fff2f0; border: 1px solid #ffccc7; padding: 20px; border-radius: 4px;">
          <h3>${jobName}</h3>
          <p><strong>Status:</strong> <span style="color: #ff4d4f;">Failed</span></p>
          <p><strong>Timestamp:</strong> ${timestamp}</p>
          <p><strong>Exit Code:</strong> ${exitCode || 'N/A'}</p>
          <p><strong>Error:</strong> ${error || 'Unknown error'}</p>
        </div>
        <p style="margin-top: 20px; color: #ff4d4f;">⚠️ Please check the server logs for more details.</p>
      </div>
    `;

  return await sendEmail({ to: recipient, subject, text, html });
}

module.exports = {
  sendEmail,
  sendCronNotification
};
