#!/usr/bin/env node

process.env.PRICE_UPDATE_VENDOR_ID = process.env.PRICE_UPDATE_VENDOR_ID || '17';
process.env.PRICE_UPDATE_VENDOR_NAME = process.env.PRICE_UPDATE_VENDOR_NAME || 'MetalCloak';
process.env.PRICE_UPDATE_JOB_LABEL = process.env.PRICE_UPDATE_JOB_LABEL || 'MetalCloak-Only';
process.env.PRICE_UPDATE_DERIVE_USD_COST_FROM_CAD = process.env.PRICE_UPDATE_DERIVE_USD_COST_FROM_CAD || '1';

require('./update-quadratec-only-prices-cad-store');