const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');
require('dotenv').config();

const { getEmailProvider, getEmailTransportConfig } = require('../utils/emailService');

function testTcpConnection(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      const durationMs = Date.now() - started;
      socket.end();
      resolve({ ok: true, durationMs });
    });

    socket.on('timeout', () => {
      const durationMs = Date.now() - started;
      socket.destroy();
      resolve({ ok: false, timeout: true, durationMs });
    });

    socket.on('error', (error) => {
      resolve({ ok: false, error: error.code || error.message });
    });
  });
}

async function main() {
  const provider = getEmailProvider();
  const config = getEmailTransportConfig();
  const service = config.service || 'custom';
  const host = config.host || (service === 'gmail' ? 'smtp.gmail.com' : null);
  const port = config.port || (service === 'gmail' ? 465 : null);
  const timeoutMs = config.connectionTimeout || 10000;

  if (provider === 'sendgrid-api') {
    const apiHost = 'api.sendgrid.com';
    const apiPort = 443;
    const apiKey = process.env.SENDGRID_API_KEY;

    console.log('Email API config summary:');
    console.log(JSON.stringify({
      provider,
      host: apiHost,
      port: apiPort,
      hasApiKey: Boolean(apiKey),
      timeoutMs,
    }, null, 2));

    if (!apiKey) {
      console.error('No SENDGRID_API_KEY configured for sendgrid-api mode.');
      process.exitCode = 1;
      return;
    }

    try {
      const result = await dns.lookup(apiHost);
      console.log(`DNS OK: ${apiHost} -> ${result.address}`);
    } catch (error) {
      console.error(`DNS ERROR: ${apiHost} -> ${error.message}`);
      process.exitCode = 1;
      return;
    }

    const tcp = await testTcpConnection(apiHost, apiPort, timeoutMs);
    if (!tcp.ok) {
      if (tcp.timeout) {
        console.error(`TCP TIMEOUT: ${apiHost}:${apiPort} after ${tcp.durationMs}ms`);
      } else {
        console.error(`TCP ERROR: ${apiHost}:${apiPort} -> ${tcp.error}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`TCP OK: ${apiHost}:${apiPort} in ${tcp.durationMs}ms`);

    try {
      const response = await axios.get('https://api.sendgrid.com/v3/scopes', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: Number(process.env.EMAIL_API_TIMEOUT_MS || 15000),
      });
      console.log(`HTTP OK: GET /v3/scopes -> ${response.status}`);
      return;
    } catch (error) {
      const status = error.response && error.response.status;
      console.error(`HTTP ERROR: ${status || error.code || error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log('SMTP transport config summary:');
  console.log(JSON.stringify({
    provider,
    service,
    host,
    port,
    secure: config.secure,
    hasAuthUser: Boolean(config.auth && config.auth.user),
    connectionTimeout: config.connectionTimeout,
    greetingTimeout: config.greetingTimeout,
    socketTimeout: config.socketTimeout,
  }, null, 2));

  if (!host || !port) {
    console.error('No SMTP host/port could be determined from environment.');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await dns.lookup(host);
    console.log(`DNS OK: ${host} -> ${result.address}`);
  } catch (error) {
    console.error(`DNS ERROR: ${host} -> ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const tcp = await testTcpConnection(host, port, timeoutMs);
  if (tcp.ok) {
    console.log(`TCP OK: ${host}:${port} in ${tcp.durationMs}ms`);
  } else if (tcp.timeout) {
    console.error(`TCP TIMEOUT: ${host}:${port} after ${tcp.durationMs}ms`);
    process.exitCode = 1;
  } else {
    console.error(`TCP ERROR: ${host}:${port} -> ${tcp.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Email connectivity test failed:', error.message);
  process.exitCode = 1;
});