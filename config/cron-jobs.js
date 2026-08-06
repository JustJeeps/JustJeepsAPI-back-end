// Central cron job definitions (single source for server.js, for the
// scripts/verify-cron-scripts.js checker and for CI).
//
// IMPORTANT: this module must stay "pure": only process.env and literal data.
// Do not require prisma/express/nodemailer here, so that validation scripts can
// load it without starting the server.

const cronEnabled = process.env.CRON_ENABLED !== 'false';
const cronTimezone = process.env.CRON_TIMEZONE || 'America/Toronto';
const commandCronNotifyOnSuccess = process.env.CRON_COMMAND_NOTIFY_ON_SUCCESS !== 'false';
const dailySeedEnabled = process.env.CRON_SEED_ALL_ENABLED !== 'false';
const dailySeedSchedule = process.env.CRON_SEED_ALL_SCHEDULE || '0 6,19 * * *';
const ordersDeltaSeedEnabled = process.env.CRON_SEED_ORDERS_DELTA_ENABLED !== 'false';
const ordersDeltaSeedSchedule = process.env.CRON_SEED_ORDERS_DELTA_SCHEDULE || '*/5 * * * *';
const allProductsSeedEnabled = process.env.CRON_SEED_ALL_PRODUCTS_ENABLED !== 'false';
const allProductsSeedSchedule = process.env.CRON_SEED_ALL_PRODUCTS_SCHEDULE || '45 */6 * * *';
const meyerSeedEnabled = process.env.CRON_SEED_MEYER_ENABLED !== 'false';
const meyerSeedSchedule = process.env.CRON_SEED_MEYER_SCHEDULE || '7 */4 * * *';
const roughCountrySeedEnabled = process.env.CRON_SEED_ROUGH_COUNTRY_ENABLED !== 'false';
const roughCountrySeedSchedule = process.env.CRON_SEED_ROUGH_COUNTRY_SCHEDULE || '37 */4 * * *';
// Misleading historical names: "PRIORITY" controls the magento-attributes-daily
// job and "ROUGH" controls magento-attributes-weekly. Kept for compatibility
// with deploy.yml and existing environments.
const magentoAttributesPriorityEnabled = process.env.CRON_MAGENTO_ATTRIBUTES_PRIORITY_ENABLED !== 'false';
const magentoAttributesPrioritySchedule = process.env.CRON_MAGENTO_ATTRIBUTES_PRIORITY_SCHEDULE || '20 2 * * *';
const magentoAttributesRoughEnabled = process.env.CRON_MAGENTO_ATTRIBUTES_ROUGH_ENABLED !== 'false';
const magentoAttributesRoughSchedule = process.env.CRON_MAGENTO_ATTRIBUTES_ROUGH_SCHEDULE || '20 15 * * *';
const skuCostAlertEnabled = process.env.CRON_SKU_COST_ALERT_ENABLED !== 'false';
const skuCostAlertSchedule = process.env.CRON_SKU_COST_ALERT_SCHEDULE || '*/30 * * * *';
const skuCostAlertSku = process.env.SKU_COST_ALERT_SKU || 'TH-635801';
const cadDisabledUsWeeklyEnabled = process.env.CRON_CAD_US_WEEKLY_ENABLED !== 'false';
const cadDisabledUsWeeklySchedule = process.env.CRON_CAD_US_WEEKLY_SCHEDULE || '30 6 * * 1';
// Keystone feed fetch (FTP -> Spaces): opt-in until the bucket is provisioned
// (DO_SPACES_*). The schedule sits off the delta's */5 grid and leaves room
// before seed-all (global mutex across command crons).
const keystoneFeedFetchEnabled = process.env.CRON_FEED_FETCH_KEYSTONE_ENABLED === 'true';
const keystoneFeedFetchSchedule = process.env.CRON_FEED_FETCH_KEYSTONE_SCHEDULE || '47 4,16 * * *';
const testCronEnabled = process.env.CRON_TEST_ENABLED === 'true';
const testCronSchedule = process.env.CRON_TEST_SCHEDULE || '*/5 * * * *';
const testCronCommand = process.env.CRON_TEST_COMMAND || 'seed-tdot';
const testCronJobName = process.env.CRON_TEST_JOB_NAME || 'Cron Test Job';
const testCronLogFile = process.env.CRON_TEST_LOG_FILE || `prisma/seeds/logs/${testCronCommand}.log`;
const testCronNotifyOnSuccess = process.env.CRON_TEST_NOTIFY_ON_SUCCESS
	? process.env.CRON_TEST_NOTIFY_ON_SUCCESS !== 'false'
	: commandCronNotifyOnSuccess;
const cancellationReportEnabled = process.env.CRON_CANCELLATION_REPORT_ENABLED !== 'false';
const cancellationReportSchedule = process.env.CRON_CANCELLATION_REPORT_SCHEDULE || '59 23 * * *';
const cancellationReportTimezone = process.env.CRON_CANCELLATION_REPORT_TIMEZONE || cronTimezone;
const skuStatusReportEnabled = process.env.CRON_SKU_STATUS_REPORT_ENABLED !== 'false';
const skuStatusReportSchedule = process.env.CRON_SKU_STATUS_REPORT_SCHEDULE || '0 22 * * *';
const skuStatusReportTimezone = process.env.CRON_SKU_STATUS_REPORT_TIMEZONE || cronTimezone;
const skuStatusWeeklyReportEnabled = process.env.CRON_SKU_STATUS_WEEKLY_REPORT_ENABLED !== 'false';
const skuStatusWeeklyReportSchedule = process.env.CRON_SKU_STATUS_WEEKLY_REPORT_SCHEDULE || '0 18 * * 5';
const skuStatusWeeklyReportTimezone = process.env.CRON_SKU_STATUS_WEEKLY_REPORT_TIMEZONE || skuStatusReportTimezone;
const cronDigestEnabled = process.env.CRON_DIGEST_ENABLED === 'true';
const cronDigestSchedule = process.env.CRON_DIGEST_SCHEDULE || '10 0 * * *';
const cronDigestTimezone = process.env.CRON_DIGEST_TIMEZONE || cronTimezone;
const qbFreshnessReportEnabled = process.env.CRON_QB_FRESHNESS_REPORT_ENABLED !== 'false';
const qbFreshnessReportSchedule = process.env.CRON_QB_FRESHNESS_REPORT_SCHEDULE || '15 9 * * *';
const qbFreshnessReportTimezone = process.env.CRON_QB_FRESHNESS_REPORT_TIMEZONE || cronTimezone;
// QuickBooks snapshot age thresholds (days). The lookup feeds fraud triage:
// stale data silently degrades the decision.
const qbStaleWarnDays = Number(process.env.QB_STALE_WARN_DAYS || 14);
const qbStaleCritDays = Number(process.env.QB_STALE_CRIT_DAYS || 30);
const cronChildTimeoutMs = Number(process.env.CRON_CHILD_TIMEOUT_MS || 10 * 60 * 60 * 1000);
const cronChildKillGraceMs = Number(process.env.CRON_CHILD_KILL_GRACE_MS || 10000);

// Command crons: executed via spawn("npm run <command>"). Every `command` MUST
// exist in package.json.scripts (validated at boot and by verify-cron).
function getCronJobDefinitions({ includeDisabled = false } = {}) {
	const jobs = [
		{
			enabled: dailySeedEnabled,
			schedule: dailySeedSchedule,
			command: 'seed-all',
			jobName: 'Daily Vendor Sync (seed-all)',
			logPrefix: 'Daily seed-all',
			reportLogFile: 'prisma/seeds/logs/seed-all.log',
			readSummaryFile: 'prisma/seeds/logs/seed-all-summary.json',
		},
		{
			enabled: ordersDeltaSeedEnabled,
			schedule: ordersDeltaSeedSchedule,
			command: 'seed-orders-delta',
			jobName: 'Orders Incremental Sync (delta)',
			logPrefix: 'Orders delta sync',
			reportLogFile: 'prisma/seeds/logs/seed-orders-delta.log',
			// Runs every few minutes: success stays silent, only failures notify
			notifyOnSuccess: false,
		},
		{
			enabled: allProductsSeedEnabled,
			schedule: allProductsSeedSchedule,
			command: 'seed-allProducts',
			jobName: 'Magento Products Sync',
			logPrefix: 'Magento products sync',
			reportLogFile: 'prisma/seeds/logs/seed-allProducts.log',
		},
		{
			enabled: meyerSeedEnabled,
			schedule: meyerSeedSchedule,
			command: 'seed-meyer',
			jobName: 'Meyer Sync',
			logPrefix: 'Meyer sync',
			reportLogFile: 'prisma/seeds/logs/seed-meyer.log',
		},
		{
			enabled: roughCountrySeedEnabled,
			schedule: roughCountrySeedSchedule,
			command: 'seed-roughCountry',
			jobName: 'Rough Country Sync',
			logPrefix: 'Rough Country sync',
			reportLogFile: 'prisma/seeds/logs/seed-roughCountry.log',
		},
		{
			enabled: magentoAttributesPriorityEnabled,
			schedule: magentoAttributesPrioritySchedule,
			command: 'magento-attributes-daily',
			jobName: 'Magento Attributes Daily Sync (Rough Country + KeyParts)',
			logPrefix: 'Magento attributes daily sync',
			reportLogFile: 'logs/magento-attributes-daily.log',
		},
		{
			enabled: magentoAttributesRoughEnabled,
			schedule: magentoAttributesRoughSchedule,
			command: 'magento-attributes-weekly',
			jobName: 'Magento Attributes Weekly Sync (Omix + AEV + MetalCloak)',
			logPrefix: 'Magento attributes weekly sync',
			reportLogFile: 'logs/magento-attributes-weekly.log',
		},
		{
			enabled: skuCostAlertEnabled,
			schedule: skuCostAlertSchedule,
			command: 'alert-sku-cost',
			jobName: `SKU Cost Alert Watch (${skuCostAlertSku})`,
			logPrefix: `SKU cost alert watch (${skuCostAlertSku})`,
			reportLogFile: 'logs/alert-sku-cost.log',
		},
		{
			enabled: cadDisabledUsWeeklyEnabled,
			schedule: cadDisabledUsWeeklySchedule,
			command: 'cad-disabled-us-enabled-weekly',
			jobName: 'CAD/US Status Weekly Fix',
			logPrefix: 'CAD/US weekly status fix',
			reportLogFile: 'logs/cad-disabled-us-enabled-weekly.log',
		},
		{
			enabled: keystoneFeedFetchEnabled,
			schedule: keystoneFeedFetchSchedule,
			command: 'feed-fetch-keystone',
			jobName: 'Keystone FTP Feed Fetch',
			logPrefix: 'Keystone FTP feed fetch',
			reportLogFile: 'logs/feed-fetch-keystone.log',
		},
		{
			enabled: testCronEnabled,
			schedule: testCronSchedule,
			command: testCronCommand,
			jobName: testCronJobName,
			logPrefix: testCronJobName,
			reportLogFile: testCronLogFile,
			notifyOnSuccess: testCronNotifyOnSuccess,
		},
	];

	return jobs
		.filter((job) => includeDisabled || job.enabled !== false)
		.map((job) => ({
			notifyOnSuccess: commandCronNotifyOnSuccess,
			...job,
		}));
}

// Report crons: they run in-process inside server.js (with their own handlers).
// The `command` here is only a dashboard identifier: it is NOT an npm script.
function getReportCronJobDefinitions({ includeDisabled = false } = {}) {
	return [
		{
			enabled: cancellationReportEnabled,
			schedule: cancellationReportSchedule,
			command: 'report-order-cancellations-daily',
			jobName: 'Daily Cancelled Orders Report',
			logPrefix: 'Daily cancelled orders report',
			reportLogFile: 'logs/report-order-cancellations-daily.log',
			timezone: cancellationReportTimezone,
		},
		{
			enabled: skuStatusReportEnabled,
			schedule: skuStatusReportSchedule,
			command: 'report-sku-status-daily',
			jobName: 'Daily SKU Status Change Report',
			logPrefix: 'Daily SKU status change report',
			reportLogFile: 'logs/report-sku-status-daily.log',
			timezone: skuStatusReportTimezone,
		},
		{
			enabled: skuStatusWeeklyReportEnabled,
			schedule: skuStatusWeeklyReportSchedule,
			command: 'report-sku-status-weekly',
			jobName: 'Weekly SKU Status Change Report',
			logPrefix: 'Weekly SKU status change report',
			reportLogFile: 'logs/report-sku-status-weekly.log',
			timezone: skuStatusWeeklyReportTimezone,
		},
		{
			enabled: cronDigestEnabled,
			schedule: cronDigestSchedule,
			command: 'report-cron-digest-daily',
			jobName: 'Daily Cron Activity Digest',
			logPrefix: 'Daily cron activity digest',
			reportLogFile: 'logs/report-cron-digest-daily.log',
			timezone: cronDigestTimezone,
		},
		{
			enabled: qbFreshnessReportEnabled,
			schedule: qbFreshnessReportSchedule,
			command: 'report-quickbooks-freshness',
			jobName: 'QuickBooks Data Freshness Check',
			logPrefix: 'QuickBooks data freshness check',
			reportLogFile: 'logs/report-quickbooks-freshness.log',
			timezone: qbFreshnessReportTimezone,
		},
	].filter((job) => includeDisabled || job.enabled !== false);
}

function getCronDashboardDefinitions() {
	return [
		...getCronJobDefinitions(),
		...getReportCronJobDefinitions(),
	];
}

module.exports = {
	getCronJobDefinitions,
	getReportCronJobDefinitions,
	getCronDashboardDefinitions,
	config: {
		cronEnabled,
		cronTimezone,
		commandCronNotifyOnSuccess,
		dailySeedEnabled,
		dailySeedSchedule,
		ordersDeltaSeedEnabled,
		ordersDeltaSeedSchedule,
		allProductsSeedEnabled,
		allProductsSeedSchedule,
		meyerSeedEnabled,
		meyerSeedSchedule,
		roughCountrySeedEnabled,
		roughCountrySeedSchedule,
		magentoAttributesPriorityEnabled,
		magentoAttributesPrioritySchedule,
		magentoAttributesRoughEnabled,
		magentoAttributesRoughSchedule,
		skuCostAlertEnabled,
		skuCostAlertSchedule,
		skuCostAlertSku,
		cadDisabledUsWeeklyEnabled,
		cadDisabledUsWeeklySchedule,
		keystoneFeedFetchEnabled,
		keystoneFeedFetchSchedule,
		testCronEnabled,
		testCronSchedule,
		testCronCommand,
		testCronJobName,
		testCronLogFile,
		testCronNotifyOnSuccess,
		cancellationReportEnabled,
		cancellationReportSchedule,
		cancellationReportTimezone,
		skuStatusReportEnabled,
		skuStatusReportSchedule,
		skuStatusReportTimezone,
		skuStatusWeeklyReportEnabled,
		skuStatusWeeklyReportSchedule,
		skuStatusWeeklyReportTimezone,
		cronDigestEnabled,
		cronDigestSchedule,
		cronDigestTimezone,
		qbFreshnessReportEnabled,
		qbFreshnessReportSchedule,
		qbFreshnessReportTimezone,
		qbStaleWarnDays,
		qbStaleCritDays,
		cronChildTimeoutMs,
		cronChildKillGraceMs,
	},
};
