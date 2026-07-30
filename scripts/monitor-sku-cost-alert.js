#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const prisma = require('../lib/prisma');
const { sendEmail } = require('../utils/emailService');

dotenv.config();

const DEFAULT_SKU = 'TH-635801';
const DEFAULT_VENDOR_NAME = 'Meyer';
const DEFAULT_STATE_FILE = path.resolve(__dirname, '../logs/sku-cost-alert-state.json');
const COST_EPSILON = 0.00001;

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getEnvConfig() {
  return {
    sku: String(process.env.SKU_COST_ALERT_SKU || DEFAULT_SKU).trim(),
    vendorName: String(process.env.SKU_COST_ALERT_VENDOR || DEFAULT_VENDOR_NAME).trim(),
    recipients: String(process.env.SKU_COST_ALERT_RECIPIENTS || process.env.CRON_NOTIFICATION_EMAIL || '').trim(),
    stateFile: String(process.env.SKU_COST_ALERT_STATE_FILE || DEFAULT_STATE_FILE).trim(),
    timezone: String(process.env.CRON_TIMEZONE || 'America/Toronto').trim(),
  };
}

function buildStateKey(vendorName, sku) {
  return `${String(vendorName || '').toLowerCase()}::${String(sku || '').toUpperCase()}`;
}

function readStateFile(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    console.warn(`⚠️ Could not read state file ${stateFile}: ${error.message}`);
  }

  return {};
}

function writeStateFile(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

async function loadVendor(vendorName) {
  return prisma.vendor.findFirst({
    where: {
      name: {
        contains: vendorName,
        mode: 'insensitive',
      },
    },
    select: {
      id: true,
      name: true,
    },
  });
}

async function loadSkuCostSnapshot(sku, vendorId) {
  const product = await prisma.product.findFirst({
    where: { sku },
    select: {
      sku: true,
      name: true,
      brand_name: true,
      price: true,
      vendorProducts: {
        where: {
          vendor_id: vendorId,
        },
        select: {
          vendor_cost: true,
          vendor_cost_usd: true,
          vendor_inventory: true,
          partStatus_meyer: true,
          vendor_sku: true,
        },
        take: 1,
      },
    },
  });

  if (!product) {
    return null;
  }

  const vp = product.vendorProducts && product.vendorProducts[0] ? product.vendorProducts[0] : null;
  if (!vp) {
    return {
      sku: product.sku,
      name: product.name,
      brandName: product.brand_name,
      currentStorePrice: toNumberOrNull(product.price),
      vendorCost: null,
      vendorCostUsd: null,
      vendorInventory: null,
      partStatusMeyer: null,
      vendorSku: null,
    };
  }

  return {
    sku: product.sku,
    name: product.name,
    brandName: product.brand_name,
    currentStorePrice: toNumberOrNull(product.price),
    vendorCost: toNumberOrNull(vp.vendor_cost),
    vendorCostUsd: toNumberOrNull(vp.vendor_cost_usd),
    vendorInventory: toNumberOrNull(vp.vendor_inventory),
    partStatusMeyer: vp.partStatus_meyer || null,
    vendorSku: vp.vendor_sku || null,
  };
}

function formatTimestamp(date, timezone) {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
  });
}

function buildAlertEmail({ vendorName, snapshot, previousCost, currentCost, checkedAt, timezone }) {
  const when = formatTimestamp(checkedAt, timezone);
  const diff = Number((currentCost - previousCost).toFixed(2));
  const diffAbs = Number(Math.abs(diff).toFixed(2));
  const direction = diff < 0 ? 'decreased' : 'changed';

  const subject = `SKU Cost Alert: ${snapshot.sku} ${direction} (${vendorName})`;

  const lines = [
    `SKU cost alert triggered for ${snapshot.sku}.`,
    '',
    `Vendor: ${vendorName}`,
    `SKU: ${snapshot.sku}`,
    `Product: ${snapshot.name || '(unknown)'}`,
    `Brand: ${snapshot.brandName || '(unknown)'}`,
    `Vendor SKU: ${snapshot.vendorSku || '(unknown)'}`,
    `Previous vendor cost: ${previousCost}`,
    `Current vendor cost: ${currentCost}`,
    `Change: -${diffAbs}`,
    `Current store price: ${snapshot.currentStorePrice ?? '(unknown)'}`,
    `Vendor inventory: ${snapshot.vendorInventory ?? '(unknown)'}`,
    `Part status: ${snapshot.partStatusMeyer || '(unknown)'}`,
    `Checked at: ${when}`,
  ];

  const text = lines.join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; line-height: 1.45;">
      <h2 style="margin-bottom: 8px; color: #166534;">SKU Cost Alert</h2>
      <p style="margin-top: 0;">The monitored vendor cost has decreased.</p>
      <table style="border-collapse: collapse; width: 100%; margin-top: 12px;">
        <tbody>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Vendor</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${vendorName}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>SKU</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.sku}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Product</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.name || '(unknown)'}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Brand</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.brandName || '(unknown)'}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Vendor SKU</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.vendorSku || '(unknown)'}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Previous Cost</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${previousCost}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Current Cost</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${currentCost}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Drop</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb; color: #166534;">-${diffAbs}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Current Store Price</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.currentStorePrice ?? '(unknown)'}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Vendor Inventory</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.vendorInventory ?? '(unknown)'}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Part Status</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${snapshot.partStatusMeyer || '(unknown)'}</td></tr>
          <tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;"><strong>Checked At</strong></td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${when}</td></tr>
        </tbody>
      </table>
    </div>
  `;

  return { subject, text, html };
}

async function run() {
  const config = getEnvConfig();
  if (!config.sku) {
    throw new Error('SKU_COST_ALERT_SKU is required');
  }

  console.log(`🔎 SKU cost alert check started for ${config.vendorName} / ${config.sku}`);

  const vendor = await loadVendor(config.vendorName);
  if (!vendor) {
    throw new Error(`Could not find vendor containing \"${config.vendorName}\"`);
  }

  const snapshot = await loadSkuCostSnapshot(config.sku, vendor.id);
  if (!snapshot) {
    throw new Error(`Could not find product with SKU ${config.sku}`);
  }

  if (!Number.isFinite(snapshot.vendorCost) || snapshot.vendorCost == null) {
    throw new Error(`No vendor_cost found for ${config.sku} from vendor ${vendor.name}`);
  }

  const state = readStateFile(config.stateFile);
  const stateKey = buildStateKey(vendor.name, config.sku);
  const previous = state[stateKey] || null;
  const previousCost = toNumberOrNull(previous && previous.lastCost);
  const currentCost = snapshot.vendorCost;
  const checkedAt = new Date();

  const hasComparablePreviousCost = previousCost != null && previousCost > 0;

  if (hasComparablePreviousCost && currentCost < (previousCost - COST_EPSILON)) {
    const email = buildAlertEmail({
      vendorName: vendor.name,
      snapshot,
      previousCost,
      currentCost,
      checkedAt,
      timezone: config.timezone,
    });

    const delivery = await sendEmail({
      to: config.recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    if (!delivery || !delivery.success) {
      throw new Error(delivery && (delivery.error || delivery.message) ? (delivery.error || delivery.message) : 'Failed to send alert email');
    }

    console.log(`📧 Alert email sent to ${config.recipients} for ${config.sku} (cost drop ${previousCost} -> ${currentCost})`);
  } else if (!hasComparablePreviousCost) {
    console.log(`ℹ️ Baseline saved for ${config.sku}: ${currentCost}`);
  } else {
    console.log(`ℹ️ No drop detected for ${config.sku}: previous ${previousCost}, current ${currentCost}`);
  }

  state[stateKey] = {
    sku: config.sku,
    vendorName: vendor.name,
    lastCost: currentCost,
    lastCostUsd: snapshot.vendorCostUsd,
    currentStorePrice: snapshot.currentStorePrice,
    vendorInventory: snapshot.vendorInventory,
    partStatusMeyer: snapshot.partStatusMeyer,
    checkedAt: checkedAt.toISOString(),
  };

  writeStateFile(config.stateFile, state);
}

run()
  .catch((error) => {
    console.error('❌ SKU cost alert failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
