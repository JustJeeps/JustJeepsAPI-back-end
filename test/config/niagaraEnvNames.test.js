// Pins every NIAGARA_* env name and its clamps (DD-021) before the Shopify
// competitor code is shared: each name is set to an in-range value, a value
// above its maximum and a value below its minimum, and the whole config is
// compared with a committed fixture. A renamed or re-clamped variable fails here.
//
// Regenerate the fixture only on purpose: UPDATE_GOLDEN=1 node --test <this file>

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { getNiagaraConfig, getNiagaraOfflineConfig, COMPETITOR, DEFAULTS } = require('../../config/niagara');

const FIXTURE = path.join(__dirname, 'fixtures', 'niagara-env.json');
const CONTACT = { SCRAPER_CONTACT_EMAIL: 'ops@example.com' };

const INT_NAMES = [
	'NIAGARA_MAX_PRICE', 'NIAGARA_SNAPSHOT_MAX_AGE_HOURS', 'NIAGARA_MIN_ITEMS', 'NIAGARA_MIN_MATCHED',
	'NIAGARA_PAGE_SIZE', 'NIAGARA_REQUEST_DELAY_MS', 'NIAGARA_JITTER_MS', 'NIAGARA_REQUEST_TIMEOUT_MS',
	'NIAGARA_MAX_ATTEMPTS', 'NIAGARA_BACKOFF_MS', 'NIAGARA_RETRY_AFTER_CAP_MS', 'NIAGARA_CHALLENGE_RETRY_DELAY_MS',
	'NIAGARA_CONSECUTIVE_FAILURE_LIMIT', 'NIAGARA_MAX_REQUESTS', 'NIAGARA_MAX_RUN_MINUTES', 'NIAGARA_MAX_PAGES_PER_BRAND',
];
const RATIO_NAMES = ['NIAGARA_MAX_FAILED_REQUEST_RATIO', 'NIAGARA_MAX_BRANDS_FAILED_RATIO', 'NIAGARA_MAX_INVALID_RATIO', 'NIAGARA_MATCH_DROP_RATIO'];

function cases() {
	const out = { defaults: getNiagaraConfig(CONTACT), offlineDefaults: getNiagaraOfflineConfig({}), baseUrl: getNiagaraConfig({ ...CONTACT, NIAGARA_BASE_URL: 'https://x.test' }).baseUrl };
	for (const name of INT_NAMES) {
		out[name] = ['7', '99999999999', '-5', 'abc'].map((value) => getNiagaraConfig({ ...CONTACT, [name]: value }));
	}
	for (const name of RATIO_NAMES) {
		out[name] = ['0.33', '1.5', '0', 'abc'].map((value) => getNiagaraConfig({ ...CONTACT, [name]: value }));
	}
	out.competitor = COMPETITOR;
	out.defaultsTable = DEFAULTS;
	return JSON.parse(JSON.stringify(out));
}

test('every NIAGARA_* env name and clamp gives the pinned config', () => {
	const actual = cases();
	if (process.env.UPDATE_GOLDEN === '1') {
		fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
		fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
	}
	assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
});

test('each pinned env name changes the config, so none is silently ignored', () => {
	const base = JSON.stringify(getNiagaraConfig(CONTACT));
	for (const name of [...INT_NAMES, ...RATIO_NAMES]) {
		const value = RATIO_NAMES.includes(name) ? '0.33' : '7';
		assert.notStrictEqual(JSON.stringify(getNiagaraConfig({ ...CONTACT, [name]: value })), base, name);
	}
});

test('the contact e-mail stays required for a live run only', () => {
	assert.throws(() => getNiagaraConfig({}), /SCRAPER_CONTACT_EMAIL is required/);
	assert.doesNotThrow(() => getNiagaraOfflineConfig({}));
});
