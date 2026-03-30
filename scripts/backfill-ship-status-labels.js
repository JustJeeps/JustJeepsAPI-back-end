const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const axios = require('axios');
const prisma = require('../lib/prisma');

const API_BASE = process.env.MAGENTO_API_BASE || 'https://www.justjeeps.com/rest/V1';
const TOKEN = process.env.MAGENTO_KEY || process.env.MAGENTO_TOKEN;

if (!TOKEN) {
  console.error('MAGENTO_KEY (or MAGENTO_TOKEN) is required. Export it before running this script.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const getIntArg = (prefix) => {
  const arg = args.find((value) => value.startsWith(prefix));
  if (!arg) return null;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : null;
};

const limit = getIntArg('--limit=');
const pageSize = getIntArg('--page-size=') || 50;
const delayMs = getIntArg('--delay-ms=') ?? 150;
const startEntityId = getIntArg('--start-entity=') || 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isNumericString = (value) => typeof value === 'string' && /^[0-9]+$/.test(value);
const isBlank = (value) => value === null || value === undefined || String(value).trim() === '';

const fetchShipStatusLabel = async (entityId) => {
  const url = `${API_BASE}/orders/${entityId}`;
  const response = await axios.get(url, { headers });
  const order = response.data;
  const attrs = order?.extension_attributes?.amasty_order_attributes;
  if (!Array.isArray(attrs)) return null;
  const attr = attrs.find((item) => item.attribute_code === 'custom_ship_status');
  return attr?.label ?? null;
};

async function run() {
  console.log('Ship status label backfill starting...');
  console.log(`API_BASE=${API_BASE}`);
  console.log(`dryRun=${dryRun} pageSize=${pageSize} delayMs=${delayMs} limit=${limit ?? 'none'}`);

  let scanned = 0;
  let attempted = 0;
  let updated = 0;
  let skipped = 0;
  let lastEntityId = startEntityId;
  let shouldStop = false;

  while (!shouldStop) {
    const rows = await prisma.order.findMany({
      where: {
        entity_id: { gt: lastEntityId },
        OR: [
          { custom_ship_status: null },
          { custom_ship_status: { not: null } },
        ],
      },
      select: {
        entity_id: true,
        increment_id: true,
        custom_ship_status: true,
      },
      orderBy: { entity_id: 'asc' },
      take: pageSize,
    });

    if (!rows.length) break;

    for (const row of rows) {
      lastEntityId = row.entity_id;

      if (limit && scanned >= limit) {
        shouldStop = true;
        break;
      }

      scanned += 1;

      const currentValue = row.custom_ship_status ? String(row.custom_ship_status) : '';
      if (!isBlank(currentValue) && !isNumericString(currentValue)) {
        skipped += 1;
        continue;
      }

      attempted += 1;

      try {
        const label = await fetchShipStatusLabel(row.entity_id);
        if (!label || label === currentValue) {
          skipped += 1;
        } else {
          if (!dryRun) {
            await prisma.order.update({
              where: { entity_id: row.entity_id },
              data: { custom_ship_status: label },
            });
          }
          updated += 1;
          console.log(
            `${dryRun ? '[DRY_RUN]' : '[UPDATED]'} entity_id=${row.entity_id} increment_id=${row.increment_id} ${currentValue} -> ${label}`
          );
        }
      } catch (error) {
        console.error(
          `[ERROR] entity_id=${row.entity_id} increment_id=${row.increment_id}`,
          error.response?.status,
          error.response?.data || error.message
        );
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  console.log('Ship status label backfill complete.');
  console.log(
    JSON.stringify(
      {
        scanned,
        attempted,
        updated,
        skipped,
        last_entity_id: lastEntityId,
        dry_run: dryRun,
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error('BACKFILL_ERROR', error.response?.status, error.response?.data || error.message);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch (_) {}
  });
