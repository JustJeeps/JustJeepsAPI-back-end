const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

/**
 * Email Service for sending notifications
 * Supports generic SMTP providers and SendGrid HTTP API
 */

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};

const getEmailProvider = () => {
  if (process.env.EMAIL_PROVIDER) return process.env.EMAIL_PROVIDER;
  if (process.env.SENDGRID_API_KEY) return 'sendgrid-api';
  return 'smtp';
};

const getEmailFrom = () => {
  const { user } = getEmailCredentials();
  return process.env.EMAIL_FROM || process.env.MAIL_FROM || (user ? `"JustJeeps API" <${user}>` : '');
};

const getEmailCredentials = () => {
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.EMAIL_PASSWORD;
  return { user, pass };
};

const getEmailTransportConfig = () => {
  const { user, pass } = getEmailCredentials();
  const service = process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = parseBoolean(process.env.SMTP_SECURE, port === 465);
  const connectionTimeout = Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000);
  const greetingTimeout = Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000);
  const socketTimeout = Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000);

  const config = {
    connectionTimeout,
    greetingTimeout,
    socketTimeout,
  };

  if (service) {
    config.service = service;
  } else if (host) {
    config.host = host;
    config.port = port;
    config.secure = secure;
  }

  if (user && pass) {
    config.auth = { user, pass };
  }

  return config;
};

const sendWithSendGridApi = async ({ to, subject, text, html }) => {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = getEmailFrom();

  if (!apiKey) {
    console.log('⚠️  Email notifications disabled - SENDGRID_API_KEY not configured');
    return { success: false, message: 'SendGrid API not configured' };
  }

  if (!from) {
    console.log('⚠️  Email notifications disabled - EMAIL_FROM not configured');
    return { success: false, message: 'Email from address not configured' };
  }

  const personalizations = String(to)
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ to: [{ email }] }));

  const response = await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    {
      personalizations,
      from: { email: from.replace(/^.*<([^>]+)>.*$/, '$1'), name: 'JustJeeps API' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html || text },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.EMAIL_API_TIMEOUT_MS || 15000),
      validateStatus: (status) => status >= 200 && status < 300,
    }
  );

  const messageId = response.headers['x-message-id'] || 'sendgrid-accepted';
  console.log('✅ Email sent successfully:', messageId);
  return { success: true, messageId };
};

// Create reusable transporter
const createTransporter = () => {
  return nodemailer.createTransport(getEmailTransportConfig());
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
    const provider = getEmailProvider();

    if (provider === 'sendgrid-api') {
      return await sendWithSendGridApi({ to, subject, text, html });
    }

    const { user } = getEmailCredentials();

    // Skip if email credentials are not configured
    if (!user) {
      console.log('⚠️  Email notifications disabled - no SMTP user configured');
      return { success: false, message: 'Email not configured' };
    }

    const transporter = createTransporter();
    
    const mailOptions = {
      from: getEmailFrom(),
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

/**
 * Send cron job report notification with per-script results
 * @param {Object} params
 * @param {string} params.jobName
 * @param {boolean} params.success
 * @param {number} params.exitCode
 * @param {string} params.error
 * @param {string} params.duration
 * @param {Array} params.results
 */
async function sendCronReport({ jobName, success, exitCode, error, duration, results = [] }) {
  const recipient = process.env.CRON_NOTIFICATION_EMAIL || 'tsantos@justjeeps.com';

  const subject = success
    ? `✅ ${jobName} - Report (All Completed)`
    : `❌ ${jobName} - Report (Some Failed)`;

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Toronto',
    dateStyle: 'full',
    timeStyle: 'long'
  });

  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);

  const formatLine = (r) => {
    const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : 'N/A';
    const log = r.logFile ? `Log: ${r.logFile}` : 'Log: N/A';
    const status = r.success ? 'SUCCESS' : 'FAILED';
    const err = r.error ? ` | Error: ${r.error}` : '';
    const excerpt = r.logExcerpt ? `\n  Recent log lines:\n${String(r.logExcerpt)
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join('\n')}` : '';
    return `- ${r.cmd}: ${status} (${dur}) | ${log}${err}${excerpt}`;
  };

  const text =
    `Cron Report: ${jobName}\n` +
    `Status: ${success ? 'Success' : 'Failed'}\n` +
    `Timestamp: ${timestamp}\n` +
    `Duration: ${duration || 'N/A'}\n` +
    `Exit Code: ${exitCode ?? 'N/A'}\n` +
    (error ? `Error: ${error}\n` : '') +
    `\nSummary: ${successes.length} succeeded, ${failures.length} failed\n\n` +
    `Succeeded:\n${successes.map(formatLine).join('\n') || '- (none)'}\n\n` +
    `Failed:\n${failures.map(formatLine).join('\n') || '- (none)'}\n`;

  const renderList = (items) =>
    items.length
      ? `<ul>${items.map(r => `<li><strong>${r.cmd}</strong> - ${r.success ? 'Success' : 'Failed'} (${r.durationMs != null ? (r.durationMs / 1000).toFixed(1) + 's' : 'N/A'})${r.logFile ? ` <br/><small>${escapeHtml(r.logFile)}</small>` : ''}${r.error ? ` <br/><small style="color:#ff4d4f;">${escapeHtml(r.error)}</small>` : ''}${r.logExcerpt ? ` <details style="margin-top:6px;"><summary style="cursor:pointer;color:#235789;">Recent log lines</summary><pre style="margin-top:8px;padding:10px;background:#f8f9fb;border:1px solid #d9d9d9;border-radius:4px;white-space:pre-wrap;font-size:12px;line-height:1.45;">${escapeHtml(r.logExcerpt)}</pre></details>` : ''}</li>`).join('')}</ul>`
      : '<p>(none)</p>';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: ${success ? '#52c41a' : '#ff4d4f'};">
        ${success ? '✅ Job Completed' : '❌ Job Completed with Failures'}
      </h2>
      <div style="background: ${success ? '#f6ffed' : '#fff2f0'}; border: 1px solid ${success ? '#b7eb8f' : '#ffccc7'}; padding: 16px; border-radius: 4px;">
        <h3>${jobName}</h3>
        <p><strong>Status:</strong> ${success ? 'Success' : 'Failed'}</p>
        <p><strong>Timestamp:</strong> ${timestamp}</p>
        <p><strong>Duration:</strong> ${duration || 'N/A'}</p>
        <p><strong>Exit Code:</strong> ${exitCode ?? 'N/A'}</p>
        ${error ? `<p><strong>Error:</strong> ${error}</p>` : ''}
        <p><strong>Summary:</strong> ${successes.length} succeeded, ${failures.length} failed</p>
      </div>
      <h4>✅ Succeeded</h4>
      ${renderList(successes)}
      <h4 style="color:#ff4d4f;">❌ Failed</h4>
      ${renderList(failures)}
    </div>
  `;

  return await sendEmail({ to: recipient, subject, text, html });
}

const getShippingCostValue = (row) => {
  if (!row) return '';
  if (row.shipping_cost_jj !== undefined && row.shipping_cost_jj !== null) return row.shipping_cost_jj;
  return row.shipping_cost || '';
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US');
};

const buildPurchaserTable = (rows) => {
  const columns = [
    { key: 'created_at', label: 'Order Date', width: 110, format: (row) => formatDate(row.created_at) },
    {
      key: 'increment_id',
      label: 'Order ID',
      width: 110,
      format: (row) => {
        if (!row.increment_id) return '';
        if (row.entity_id) {
          const href = `https://www.justjeeps.com/admin_19q7yi/sales/order/view/order_id/${row.entity_id}`;
          return `<a href="${escapeHtml(href)}" style="color:#235789;text-decoration:none;font-weight:600;">${escapeHtml(row.increment_id)}</a>`;
        }
        return escapeHtml(row.increment_id);
      },
    },
    { key: 'total_qty_ordered', label: 'Items Ordered Qty', width: 150 },
    {
      key: 'base_total_due',
      label: 'Total Due',
      width: 110,
      format: (row) => {
        const value = row.base_total_due ?? '';
        const num = Number(value);
        const due = Number.isFinite(num) && num > 0;
        const pill = due
          ? '<span style="display:inline-block;margin-right:6px;padding:2px 6px;border-radius:999px;background:#fee4e2;color:#b42318;font-size:11px;font-weight:700;letter-spacing:0.02em;">DUE</span>'
          : '';
        return `${pill}${escapeHtml(value)}`;
      },
    },
    { key: 'custom_po_number', label: 'PO#', width: 140 },
    { key: 'custom_ship_status', label: 'Ship Status', width: 140 },
    { key: 'shipping_cost', label: 'Shipping Cost', width: 130, format: (row) => escapeHtml(getShippingCostValue(row)) },
    { key: 'custom_order_note', label: 'Order Note', width: 260 },
  ];

  const colWidthStyle = (col) => col.width ? `min-width:${col.width}px;` : '';

  const header = `
    <tr>
      ${columns
        .map(
          (col) =>
            `<th style=\"text-align:left;padding:10px 12px;background:#f8f4ef;border:1px solid #d9d9d9;font-size:13px;color:#5b6676;${colWidthStyle(col)}\">${escapeHtml(col.label)}</th>`
        )
        .join('')}
    </tr>
  `;

  const body = rows
    .map((row, index) => {
      const bg = index % 2 === 0 ? '#ffffff' : '#fcfbf9';
      const cells = columns
        .map((col) => {
          const raw = col.format ? col.format(row) : escapeHtml(row[col.key] ?? '');
          const align = ['total_qty_ordered', 'base_total_due', 'shipping_cost'].includes(col.key)
            ? 'right'
            : 'left';
          const color = col.key === 'base_total_due' && Number(row.base_total_due) > 0 ? '#b42318' : '#1c2430';
          return `<td style=\"padding:10px 12px;border:1px solid #d9d9d9;text-align:${align};color:${color};${colWidthStyle(col)}\">${raw}</td>`;
        })
        .join('');
      return `<tr style="background:${bg};">${cells}</tr>`;
    })
    .join('');

  return `
    <table style=\"width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;table-layout:auto;\">
      <thead>${header}</thead>
      <tbody>${body}</tbody>
    </table>
  `;
};

async function sendPurchaserReportEmail({ report, dateStr, initials }) {
  const recipient = process.env.PURCHASER_REPORT_EMAILS || process.env.CRON_NOTIFICATION_EMAIL || '';
  const recipients = recipient
    .split(/[,\s]+/)
    .map((email) => email.trim())
    .filter(Boolean)
    .join(',');

  if (!recipients) {
    return { success: false, error: 'No recipients configured' };
  }

  const subject = `Purchaser Report - ${dateStr}`;
  const initialsText = Array.isArray(initials) && initials.length ? initials.join(', ') : 'All';

  const renderSection = (title, rows) => {
    if (!rows.length) {
      return `
        <h3 style="margin:16px 0 8px;color:#1c2430;">${escapeHtml(title)}</h3>
        <p style="margin:0 0 12px;color:#5b6676;">No results.</p>
      `;
    }
    return `
      <h3 style="margin:16px 0 8px;color:#1c2430;">${escapeHtml(title)}</h3>
      ${buildPurchaserTable(rows)}
    `;
  };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:920px;margin:0 auto;color:#1c2430;">
      <h2 style="margin:0 0 6px;">Purchaser Report</h2>
      <p style="margin:0 0 16px;color:#5b6676;">Date: ${escapeHtml(dateStr)} | Initials: ${escapeHtml(initialsText)}</p>
      ${renderSection(`Orders closed on ${dateStr}`, report?.closed || [])}
      ${renderSection(`Orders followed up on ${dateStr}`, report?.followedUp || [])}
      ${renderSection('Orders waiting for a response', report?.waiting || [])}
    </div>
  `;

  const text = `Purchaser Report - ${dateStr}\nInitials: ${initialsText}`;

  return await sendEmail({ to: recipients, subject, text, html });
}

module.exports = {
  createTransporter,
  getEmailProvider,
  getEmailTransportConfig,
  sendEmail,
  sendCronNotification,
  sendCronReport,
  sendPurchaserReportEmail
};
