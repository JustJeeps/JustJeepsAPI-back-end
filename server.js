const Express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { format, parseISO } = require('date-fns');
const app = Express();
const BodyParser = require('body-parser');
const PORT = process.env.PORT || 8080
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const { spawn } = require('child_process');
const logger = require('./utils/logger');
const {
	sendCronNotification,
	sendCronReport,
	sendPurchaserReportEmail,
	sendOrderCancellationDailyReportEmail,
	sendSkuStatusDailyReportEmail,
	sendSkuStatusWeeklyReportEmail,
} = require('./utils/emailService');
const prisma = require('./lib/prisma');
const {
	loadDataIfNeeded: loadQuickBooksLookupData,
	queryCustomers: queryQuickBooksCustomers,
	searchCustomers: searchQuickBooksCustomers,
	buildCustomerResponse: getQuickBooksCustomerDetails,
	getQuickBooksLookupMeta,
	isDbSource: isQuickBooksDbSource,
} = require('./services/quickbooksCustomerLookup');
const seedOrders = require('./prisma/seeds/seed-individual/seed-orders.js');
const seedOrdersAll = require('./prisma/seeds/seed-individual/seed-orders-all.js');
const seedOrdersDelta = require('./prisma/seeds/seed-individual/seed-orders-delta.js');
const quadratecProducts = require('./prisma/seeds/api-calls/quadratec-excel.js');
const { getWheelProsSkus, makeApiRequestsInChunks } = require('./prisma/seeds/api-calls/wheelPros-api.js');

// Definicoes e flags de cron centralizadas em config/cron-jobs.js (modulo puro,
// tambem usado por scripts/verify-cron-scripts.js e pelo CI).
const {
	getCronJobDefinitions,
	getReportCronJobDefinitions,
	getCronDashboardDefinitions,
	config: {
		cronEnabled,
		cronTimezone,
		commandCronNotifyOnSuccess,
		dailySeedEnabled,
		dailySeedSchedule,
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
} = require('./config/cron-jobs');

function formatCronExitLabel(code, signal) {
	if (typeof code === 'number') return `exit code ${code}`;
	if (signal) return `signal ${signal}`;
	return 'unknown exit status';
}
const MAGENTO_STATUS_ALLOWED_USERS = new Set(['admin', 'jerry', 'tess', 'jacob', 'david', 'rafael', 'ricardo', 'paula']);
const ORDER_CANCEL_EXECUTE_ALLOWED_USERS = new Set(['tess', 'jerry', 'jacob', 'paula', 'karoline']);
const ORDER_CANCEL_DRY_RUN_ALLOWED_USERS = new Set(['tess']);
const ORDER_CANCEL_MANUAL_REFUND_RESTRICTED_USERS = new Set(['paula']);
const ORDER_PO_INIT_ALLOWED_USERS = new Set(['admin', 'tess', 'jerry', 'jacob', 'paula', 'karoline']);
const ORDER_CANCEL_PO_INITIALS_BY_USER = Object.freeze({
	jacob: 'JK',
	jerry: 'JD',
	paula: 'PM',
	karoline: 'KD',
	tess: 'TS',
});
const cronJobRegistry = new Map();
let cronJobsRegistered = false;
const cronHistoryFile = path.resolve(__dirname, 'logs', 'cron-job-history.json');
const cronHistoryLookbackDays = Number(process.env.CRON_HISTORY_LOOKBACK_DAYS || 30);
const cronHistoryRetentionDays = Number(process.env.CRON_HISTORY_RETENTION_DAYS || 30);
const cronLogTailLines = Number(process.env.CRON_LOG_TAIL_LINES || 300);
const cancelWorkflowHistoryFile = path.resolve(__dirname, 'logs', 'order-cancel-workflow-history.json');
const cancelWorkflowHistoryRetentionDays = Number(process.env.CANCEL_WORKFLOW_HISTORY_RETENTION_DAYS || 180);
const skuStatusHistoryFile = path.resolve(__dirname, 'logs', 'sku-status-change-history.json');
const skuStatusHistoryRetentionDays = Number(process.env.SKU_STATUS_HISTORY_RETENTION_DAYS || 180);
const quickBooksPreloadEnabled = process.env.QB_LOOKUP_PRELOAD_ON_BOOT !== 'false';
const quickBooksPreloadDelayMs = Number(process.env.QB_LOOKUP_PRELOAD_DELAY_MS || 60000);
let activeCommandCronJob = null;

function upsertCronJobRecord(command, patch) {
	const current = cronJobRegistry.get(command) || { command };
	const next = {
		...current,
		...patch,
		updatedAt: new Date().toISOString(),
	};
	cronJobRegistry.set(command, next);
	return next;
}

function readJsonFileSafe(relativeFilePath) {
	if (!relativeFilePath) return null;

	const resolvedPath = path.resolve(__dirname, relativeFilePath);
	if (!fs.existsSync(resolvedPath)) return null;

	try {
		return JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
	} catch (error) {
		logger.warn('Failed to read JSON file', {
			filePath: resolvedPath,
			error: error.message,
		});
		return null;
	}
}

function readJsonAbsoluteFileSafe(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return null;

	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch (error) {
		logger.warn('Failed to read JSON file', {
			filePath,
			error: error.message,
		});
		return null;
	}
}

function readCronHistoryEntries() {
	const history = readJsonAbsoluteFileSafe(cronHistoryFile);
	return Array.isArray(history) ? history : [];
}

function getDateStringInTimezone(value = new Date(), timeZone = 'America/Toronto') {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
}

function readCancelWorkflowHistoryEntries() {
	const history = readJsonAbsoluteFileSafe(cancelWorkflowHistoryFile);
	return Array.isArray(history) ? history : [];
}

function pruneCancelWorkflowHistoryEntries(entries) {
	const cutoff = Date.now() - (cancelWorkflowHistoryRetentionDays * 24 * 60 * 60 * 1000);
	return entries
		.filter((entry) => {
			const timestamp = new Date(entry.recordedAt || entry.cancelledAt || 0).getTime();
			return Number.isFinite(timestamp) && timestamp >= cutoff;
		})
		.sort((left, right) => {
			const leftTime = new Date(left.recordedAt || left.cancelledAt || 0).getTime();
			const rightTime = new Date(right.recordedAt || right.cancelledAt || 0).getTime();
			return rightTime - leftTime;
		});
}

function appendCancelWorkflowHistoryEntry(entry) {
	try {
		const current = readCancelWorkflowHistoryEntries();
		const next = pruneCancelWorkflowHistoryEntries([entry, ...current]);
		fs.mkdirSync(path.dirname(cancelWorkflowHistoryFile), { recursive: true });
		fs.writeFileSync(cancelWorkflowHistoryFile, JSON.stringify(next, null, 2));
	} catch (error) {
		logger.error('Failed to persist cancel workflow history entry', {
			orderId: entry?.orderId,
			error: error.message,
		});
	}
}

function buildCancelWorkflowHistoryRecordKey(entry) {
	const recordedAt = entry.recordedAt instanceof Date
		? entry.recordedAt.toISOString()
		: String(entry.recordedAt || entry.cancelledAt || '');
	return [
		recordedAt,
		entry.cancelledBy || 'unknown',
		entry.orderId || '',
		entry.incrementId || '',
		entry.requestedOrderIdentifier || '',
		entry.outcome || '',
	]
		.map((part) => String(part).replace(/\|/g, '%7C'))
		.join('|');
}

function mapCancelWorkflowHistoryEntryToDbRow(entry) {
	const recordedAt = entry.recordedAt instanceof Date
		? entry.recordedAt
		: new Date(entry.recordedAt || entry.cancelledAt || Date.now());
	const cancelledAt = entry.cancelledAt
		? (entry.cancelledAt instanceof Date ? entry.cancelledAt : new Date(entry.cancelledAt))
		: null;

	return {
		recordKey: buildCancelWorkflowHistoryRecordKey({ ...entry, recordedAt }),
		recordedAt,
		reportDate: entry.reportDate,
		timeZone: entry.timeZone || cancellationReportTimezone || 'America/Toronto',
		cancelledAt,
		cancelledBy: entry.cancelledBy || 'unknown',
		dryRun: Boolean(entry.dryRun),
		outcome: entry.outcome || 'unknown',
		orderId: entry.orderId ? Number(entry.orderId) : null,
		incrementId: entry.incrementId || '',
		requestedOrderIdentifier: entry.requestedOrderIdentifier || '',
		orderCancelledInMagento: Boolean(entry.orderCancelledInMagento),
		invoiceVoidDeleteCompleted: Boolean(entry.invoiceVoidDeleteCompleted),
		cancellationTicketSent: Boolean(entry.cancellationTicketSent),
		cancellationAttributesUpdated: Boolean(entry.cancellationAttributesUpdated),
		localStatusUpdated: Boolean(entry.localStatusUpdated),
		failedActions: Array.isArray(entry.failedActions) ? entry.failedActions : [],
		completedActions: Array.isArray(entry.completedActions) ? entry.completedActions : [],
		manualActionsStillRequired: Array.isArray(entry.manualActionsStillRequired) ? entry.manualActionsStillRequired : [],
		orderSnapshot: entry.orderSnapshot || {},
	};
}

function mapCancelWorkflowDbRowToHistoryEntry(entry) {
	return {
		...entry,
		recordedAt: entry.recordedAt,
		cancelledAt: entry.cancelledAt,
		failedActions: Array.isArray(entry.failedActions) ? entry.failedActions : [],
		completedActions: Array.isArray(entry.completedActions) ? entry.completedActions : [],
		manualActionsStillRequired: Array.isArray(entry.manualActionsStillRequired) ? entry.manualActionsStillRequired : [],
		orderSnapshot: entry.orderSnapshot || {},
	};
}

async function readCancelWorkflowHistoryEntriesForReportDate(dateStr) {
	try {
		const entries = await prisma.orderCancellationWorkflowHistory.findMany({
			where: {
				reportDate: dateStr,
				dryRun: false,
				outcome: 'cancelled',
			},
			orderBy: { recordedAt: 'desc' },
		});
		return entries.map(mapCancelWorkflowDbRowToHistoryEntry);
	} catch (error) {
		logger.warn('Failed to read cancellation workflow history from database; falling back to log file', {
			error: error.message,
			reportDate: dateStr,
		});
		return readCancelWorkflowHistoryEntries().filter((entry) => {
			if (!entry || entry.dryRun) return false;
			if (entry.outcome !== 'cancelled') return false;
			return entry.reportDate === dateStr;
		});
	}
}

async function backfillCancelWorkflowHistoryFromFileToDatabase() {
	const fileEntries = readCancelWorkflowHistoryEntries()
		.filter((entry) => entry?.reportDate && (entry.orderId || entry.incrementId || entry.requestedOrderIdentifier));

	if (fileEntries.length === 0) return;

	try {
		const result = await prisma.orderCancellationWorkflowHistory.createMany({
			data: fileEntries.map(mapCancelWorkflowHistoryEntryToDbRow),
			skipDuplicates: true,
		});
		logger.info('Backfilled order cancellation workflow history from log file into database', {
			fileEntries: fileEntries.length,
			inserted: result.count,
		});
	} catch (error) {
		logger.warn('Failed to backfill order cancellation workflow history from log file into database', {
			error: error.message,
		});
	}
}

function readSkuStatusHistoryEntries() {
	const history = readJsonAbsoluteFileSafe(skuStatusHistoryFile);
	return Array.isArray(history) ? history : [];
}

function pruneSkuStatusHistoryEntries(entries) {
	const cutoff = Date.now() - (skuStatusHistoryRetentionDays * 24 * 60 * 60 * 1000);
	return entries
		.filter((entry) => {
			const timestamp = new Date(entry.recordedAt || entry.changedAt || 0).getTime();
			return Number.isFinite(timestamp) && timestamp >= cutoff;
		})
		.sort((left, right) => {
			const leftTime = new Date(left.recordedAt || left.changedAt || 0).getTime();
			const rightTime = new Date(right.recordedAt || right.changedAt || 0).getTime();
			return rightTime - leftTime;
		});
}

function appendSkuStatusHistoryEntries(entries) {
	if (!Array.isArray(entries) || entries.length === 0) return;

	try {
		const current = readSkuStatusHistoryEntries();
		const next = pruneSkuStatusHistoryEntries([...entries, ...current]);
		fs.mkdirSync(path.dirname(skuStatusHistoryFile), { recursive: true });
		fs.writeFileSync(skuStatusHistoryFile, JSON.stringify(next, null, 2));
	} catch (error) {
		logger.error('Failed to persist SKU status history entries', {
			count: entries.length,
			error: error.message,
		});
	}
}

function getUserDisplayName(user) {
	const name = [user?.firstname, user?.lastname].filter(Boolean).join(' ').trim();
	return name || user?.username || 'unknown';
}

function normalizeSkuStatusReportSource(source) {
	const value = String(source || '').trim().toLowerCase();
	if (value === 'items.jsx' || value === 'items') return 'Items.jsx';
	if (value === 'ordertable.jsx' || value === 'order-table' || value === 'orders') return 'OrderTable.jsx';
	return value || 'unknown';
}

function buildSkuStatusHistoryRecordKey(entry) {
	const recordedAt = entry.recordedAt instanceof Date
		? entry.recordedAt.toISOString()
		: String(entry.recordedAt || entry.changedAt || '');
	return [
		recordedAt,
		entry.changedBy || 'unknown',
		entry.source || 'unknown',
		entry.requestedSku || entry.sku || '',
		entry.sku || '',
		entry.status ?? '',
		entry.action || '',
	]
		.map((part) => String(part).replace(/\|/g, '%7C'))
		.join('|');
}

function mapSkuStatusHistoryEntryToDbRow(entry) {
	const recordedAt = entry.recordedAt instanceof Date
		? entry.recordedAt
		: new Date(entry.recordedAt || entry.changedAt || Date.now());
	const status = Number(entry.status);
	const action = entry.action || (status === 2 ? 'disabled' : 'enabled');

	return {
		recordKey: buildSkuStatusHistoryRecordKey({ ...entry, recordedAt, action }),
		recordedAt,
		reportDate: entry.reportDate,
		timeZone: entry.timeZone || skuStatusReportTimezone || 'America/Toronto',
		changedBy: entry.changedBy || 'unknown',
		changedByName: entry.changedByName || entry.changedBy || 'unknown',
		changedByEmail: entry.changedByEmail || '',
		source: entry.source || 'unknown',
		requestedSku: entry.requestedSku || entry.sku || '',
		sku: entry.sku,
		title: entry.title || '',
		status: Number.isFinite(status) ? status : (action === 'disabled' ? 2 : 1),
		action,
		applyToChildren: Boolean(entry.applyToChildren),
		updatedStoreViews: Array.isArray(entry.updatedStoreViews) ? entry.updatedStoreViews : [],
		failedStoreViews: Array.isArray(entry.failedStoreViews) ? entry.failedStoreViews : [],
	};
}

async function backfillSkuStatusHistoryFromFileToDatabase() {
	const fileEntries = readSkuStatusHistoryEntries()
		.filter((entry) => entry?.sku && entry?.reportDate);

	if (fileEntries.length === 0) return;

	try {
		const result = await prisma.skuStatusChangeHistory.createMany({
			data: fileEntries.map(mapSkuStatusHistoryEntryToDbRow),
			skipDuplicates: true,
		});
		logger.info('Backfilled SKU status report history from log file into database', {
			fileEntries: fileEntries.length,
			inserted: result.count,
		});
	} catch (error) {
		logger.warn('Failed to backfill SKU status report history from log file into database', {
			error: error.message,
		});
	}
}

function mapSkuStatusHistoryEntryToReportRow(entry) {
	return {
		changedAt: entry.recordedAt || entry.changedAt,
		changedBy: entry.changedBy || 'unknown',
		changedByName: entry.changedByName || entry.changedBy || 'unknown',
		sku: entry.sku,
		title: entry.title || '',
		action: entry.action || (Number(entry.status) === 2 ? 'disabled' : 'enabled'),
		status: entry.status,
		source: entry.source || 'unknown',
		requestedSku: entry.requestedSku || entry.sku,
		updatedStoreViews: Array.isArray(entry.updatedStoreViews) ? entry.updatedStoreViews : [],
	};
}

function buildSkuStatusRowsFromFileForDates(dateStrings) {
	const dateSet = new Set(Array.isArray(dateStrings) ? dateStrings.filter(Boolean) : []);
	const entries = readSkuStatusHistoryEntries();
	return entries
		.filter((entry) => entry && dateSet.has(entry.reportDate))
		.sort((left, right) => {
			const leftTime = new Date(left.recordedAt || left.changedAt || 0).getTime();
			const rightTime = new Date(right.recordedAt || right.changedAt || 0).getTime();
			return rightTime - leftTime;
		})
		.map(mapSkuStatusHistoryEntryToReportRow);
}

async function buildSkuStatusRowsForDates(dateStrings) {
	const reportDates = Array.isArray(dateStrings) ? dateStrings.filter(Boolean) : [];
	if (reportDates.length === 0) return [];

	try {
		const entries = await prisma.skuStatusChangeHistory.findMany({
			where: { reportDate: { in: reportDates } },
			orderBy: { recordedAt: 'desc' },
		});
		return entries.map(mapSkuStatusHistoryEntryToReportRow);
	} catch (error) {
		logger.warn('Failed to read SKU status history from database; falling back to log file', {
			error: error.message,
			reportDates,
		});
		return buildSkuStatusRowsFromFileForDates(reportDates);
	}
}

function summarizeSkuStatusRows(rows) {
	const byUser = rows.reduce((acc, row) => {
		const user = String(row.changedBy || 'unknown').toLowerCase();
		if (!acc[user]) {
			acc[user] = { total: 0, disabled: 0, enabled: 0 };
		}
		acc[user].total += 1;
		if (row.action === 'disabled') acc[user].disabled += 1;
		if (row.action === 'enabled') acc[user].enabled += 1;
		return acc;
	}, {});

	return {
		totalChanged: rows.length,
		totalDisabled: rows.filter((row) => row.action === 'disabled').length,
		totalEnabled: rows.filter((row) => row.action === 'enabled').length,
		byUser,
	};
}

function getTrailingDateStringsInTimezone(value = new Date(), days = 7, timeZone = 'America/Toronto') {
	const date = value instanceof Date ? value : new Date(value);
	const dateStrings = [];
	for (let index = days - 1; index >= 0; index -= 1) {
		dateStrings.push(getDateStringInTimezone(new Date(date.getTime() - (index * 24 * 60 * 60 * 1000)), timeZone));
	}
	return dateStrings;
}

async function buildDailySkuStatusChangeReport(dateStr, timeZone = 'America/Toronto') {
	const rows = await buildSkuStatusRowsForDates([dateStr]);
	const summary = summarizeSkuStatusRows(rows);

	return {
		date: dateStr,
		timeZone,
		...summary,
		rows,
	};
}

async function buildWeeklySkuStatusChangeReport(endDate = new Date(), timeZone = 'America/Toronto') {
	const endDateValue = endDate instanceof Date ? endDate : new Date(`${endDate}T12:00:00`);
	const dateStrings = getTrailingDateStringsInTimezone(endDateValue, 7, timeZone);
	const rows = await buildSkuStatusRowsForDates(dateStrings);
	const summary = summarizeSkuStatusRows(rows);

	return {
		startDate: dateStrings[0],
		endDate: dateStrings[dateStrings.length - 1],
		timeZone,
		dateStrings,
		...summary,
		rows,
	};
}

async function sendDailySkuStatusReportEmailForDate(dateStr, options = {}) {
	const reportTimezone = options.timeZone || skuStatusReportTimezone || 'America/Toronto';
	const report = await buildDailySkuStatusChangeReport(dateStr, reportTimezone);

	const delivery = await sendSkuStatusDailyReportEmail({
		reportDate: report.date,
		timeZone: report.timeZone,
		summary: {
			totalChanged: report.totalChanged,
			totalDisabled: report.totalDisabled,
			totalEnabled: report.totalEnabled,
			byUser: report.byUser,
		},
		rows: report.rows,
	});

	if (!delivery?.success) {
		throw new Error(delivery?.error || delivery?.message || 'Failed to send daily SKU status report email');
	}

	return {
		report,
		delivery,
	};
}

async function sendWeeklySkuStatusReportEmailForDate(endDate, options = {}) {
	const reportTimezone = options.timeZone || skuStatusWeeklyReportTimezone || 'America/Toronto';
	const report = await buildWeeklySkuStatusChangeReport(endDate, reportTimezone);
	const reportDate = `${report.startDate} to ${report.endDate}`;

	const delivery = await sendSkuStatusWeeklyReportEmail({
		reportDate,
		timeZone: report.timeZone,
		summary: {
			totalChanged: report.totalChanged,
			totalDisabled: report.totalDisabled,
			totalEnabled: report.totalEnabled,
			byUser: report.byUser,
		},
		rows: report.rows,
	});

	if (!delivery?.success) {
		throw new Error(delivery?.error || delivery?.message || 'Failed to send weekly SKU status report email');
	}

	return {
		report,
		delivery,
	};
}

async function buildDailyCancellationReport(dateStr, timeZone = 'America/Toronto') {
	const successfulEntries = await readCancelWorkflowHistoryEntriesForReportDate(dateStr);

	const latestByOrderId = new Map();
	for (const entry of successfulEntries) {
		const orderIdKey = String(entry.orderId || entry.incrementId || entry.requestedOrderIdentifier || '');
		if (!orderIdKey) continue;

		const current = latestByOrderId.get(orderIdKey);
		const currentTime = current ? new Date(current.cancelledAt || current.recordedAt || 0).getTime() : 0;
		const nextTime = new Date(entry.cancelledAt || entry.recordedAt || 0).getTime();

		if (!current || nextTime >= currentTime) {
			latestByOrderId.set(orderIdKey, entry);
		}
	}

	const rows = Array.from(latestByOrderId.values())
		.sort((left, right) => {
			const leftTime = new Date(left.cancelledAt || left.recordedAt || 0).getTime();
			const rightTime = new Date(right.cancelledAt || right.recordedAt || 0).getTime();
			return rightTime - leftTime;
		})
		.map((entry) => {
			const snapshot = entry.orderSnapshot || {};
			const customerName = [snapshot.customer_firstname, snapshot.customer_lastname].filter(Boolean).join(' ');
			return {
				cancelledAt: entry.cancelledAt || entry.recordedAt,
				cancelledBy: entry.cancelledBy || 'unknown',
				source: 'cancel_workflow_audit',
				entityId: entry.orderId,
				incrementId: entry.incrementId || snapshot.increment_id || '',
				grandTotal: snapshot.grand_total,
				totalQtyOrdered: snapshot.total_qty_ordered,
				status: snapshot.status,
				customPoNumber: snapshot.custom_po_number,
				customShipStatus: snapshot.custom_ship_status,
				customOrderNote: snapshot.custom_order_note,
				shippingCost: snapshot.shipping_cost_jj,
				customerName,
				customerEmail: snapshot.customer_email,
				region: snapshot.region,
				paymentMethod: snapshot.method_title,
			};
		});

	rows.sort((left, right) => {
		const leftTime = new Date(left.cancelledAt || 0).getTime();
		const rightTime = new Date(right.cancelledAt || 0).getTime();
		return rightTime - leftTime;
	});

	const byUser = rows.reduce((acc, row) => {
		const user = String(row.cancelledBy || 'unknown').toLowerCase();
		acc[user] = (acc[user] || 0) + 1;
		return acc;
	}, {});

	return {
		date: dateStr,
		timeZone,
		totalCancelled: rows.length,
		paulaCancelled: byUser.paula || 0,
		byUser,
		rows,
	};
}

async function sendDailyCancellationReportEmailForDate(dateStr, options = {}) {
	const reportTimezone = options.timeZone || cancellationReportTimezone || 'America/Toronto';
	const report = await buildDailyCancellationReport(dateStr, reportTimezone);

	const delivery = await sendOrderCancellationDailyReportEmail({
		reportDate: report.date,
		timeZone: report.timeZone,
		summary: {
			totalCancelled: report.totalCancelled,
			paulaCancelled: report.paulaCancelled,
			byUser: report.byUser,
		},
		rows: report.rows,
	});

	if (!delivery?.success) {
		throw new Error(delivery?.error || delivery?.message || 'Failed to send daily cancellation report email');
	}

	return {
		report,
		delivery,
	};
}

function pruneCronHistoryEntries(entries) {
	const cutoff = Date.now() - (cronHistoryRetentionDays * 24 * 60 * 60 * 1000);
	return entries
		.filter((entry) => {
			const timestamp = new Date(entry.finishedAt || entry.startedAt || entry.createdAt || 0).getTime();
			return Number.isFinite(timestamp) && timestamp >= cutoff;
		})
		.sort((left, right) => {
			const leftTime = new Date(left.finishedAt || left.startedAt || left.createdAt || 0).getTime();
			const rightTime = new Date(right.finishedAt || right.startedAt || right.createdAt || 0).getTime();
			return rightTime - leftTime;
		});
}

function appendCronHistoryEntry(entry) {
	try {
		const current = readCronHistoryEntries();
		const next = pruneCronHistoryEntries([entry, ...current]);
		fs.mkdirSync(path.dirname(cronHistoryFile), { recursive: true });
		fs.writeFileSync(cronHistoryFile, JSON.stringify(next, null, 2));
	} catch (error) {
		logger.error('Failed to persist cron history entry', {
			command: entry?.command,
			error: error.message,
		});
	}
}

function getRecentCronHistoryForCommand(command, historyEntries = null) {
	const entries = Array.isArray(historyEntries) ? historyEntries : readCronHistoryEntries();
	const cutoff = Date.now() - (cronHistoryLookbackDays * 24 * 60 * 60 * 1000);
	return entries
		.filter((entry) => entry.command === command)
		.filter((entry) => {
			const timestamp = new Date(entry.finishedAt || entry.startedAt || entry.createdAt || 0).getTime();
			return Number.isFinite(timestamp) && timestamp >= cutoff;
		})
		.sort((left, right) => {
			const leftTime = new Date(left.finishedAt || left.startedAt || left.createdAt || 0).getTime();
			const rightTime = new Date(right.finishedAt || right.startedAt || right.createdAt || 0).getTime();
			return rightTime - leftTime;
		});
}

function deriveHistoryFromLogLines(definition, lines = []) {
	if (!Array.isArray(lines) || lines.length === 0) return [];

	const startRegex = /^\[([^\]]+)\]\s+Starting\s+.+\(npm run\s+([^\)]+)\)/i;
	const finishRegex = /^\[([^\]]+)\]\s+Finished\s+.+\s+with\s+(exit code\s+\d+|signal\s+[A-Z0-9_]+|unknown exit status)/i;
	const runs = [];
	let pendingStart = null;

	for (const line of lines) {
		const startMatch = String(line).match(startRegex);
		if (startMatch) {
			const parsedStart = new Date(startMatch[1]);
			const startedAt = Number.isFinite(parsedStart.getTime()) ? parsedStart.toISOString() : null;
			const commandFromLog = String(startMatch[2] || '').trim();
			if (startedAt && (!commandFromLog || commandFromLog === definition.command)) {
				pendingStart = { startedAt };
			}
			continue;
		}

		const finishMatch = String(line).match(finishRegex);
		if (!finishMatch) continue;

		const parsedFinish = new Date(finishMatch[1]);
		const finishedAt = Number.isFinite(parsedFinish.getTime()) ? parsedFinish.toISOString() : null;
		if (!finishedAt) continue;

		const exitLabel = finishMatch[2] || 'unknown exit status';
		const exitCodeMatch = exitLabel.match(/exit code\s+(\d+)/i);
		const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : null;
		const status = exitCode === 0 ? 'success' : 'failed';
		const startedAt = pendingStart?.startedAt || finishedAt;
		const derivedDuration = buildDurationFromTimestamps(startedAt, finishedAt);

		runs.push({
			id: `${definition.command}-${finishedAt}`,
			command: definition.command,
			jobName: definition.jobName,
			status,
			startedAt,
			finishedAt,
			durationMs: derivedDuration?.durationMs || null,
			durationLabel: derivedDuration?.durationLabel || null,
			exitCode,
			error: status === 'failed' ? `Process ended with ${exitLabel}` : null,
			notification: null,
			summary: null,
			failedResults: [],
		});

		pendingStart = null;
	}

	const cutoff = Date.now() - (cronHistoryLookbackDays * 24 * 60 * 60 * 1000);
	return runs
		.filter((entry) => {
			const timestamp = new Date(entry.finishedAt || entry.startedAt || 0).getTime();
			return Number.isFinite(timestamp) && timestamp >= cutoff;
		})
		.sort((left, right) => {
			const leftTime = new Date(left.finishedAt || left.startedAt || 0).getTime();
			const rightTime = new Date(right.finishedAt || right.startedAt || 0).getTime();
			return rightTime - leftTime;
		});
}

function getCronJobDefinitionByCommand(command) {
	return getCronDashboardDefinitions().find((definition) => definition.command === command) || null;
}

function readLogLines(logFile) {
	if (!logFile) return [];

	const resolvedPath = path.resolve(__dirname, logFile);
	if (!fs.existsSync(resolvedPath)) return [];

	try {
		return fs.readFileSync(resolvedPath, 'utf-8').split(/\r?\n/).filter(Boolean);
	} catch (error) {
		logger.warn('Failed to read cron log lines', {
			logFile: resolvedPath,
			error: error.message,
		});
		return [];
	}
}

function findLastLine(lines, matcher) {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (matcher(lines[index])) {
			return lines[index];
		}
	}
	return null;
}

function extractBracketTimestamp(line) {
	const match = String(line || '').match(/^\[([^\]]+)\]/);
	if (!match) return null;
	const date = new Date(match[1]);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildDurationFromTimestamps(startedAt, finishedAt) {
	if (!startedAt || !finishedAt) return null;
	const startMs = new Date(startedAt).getTime();
	const finishMs = new Date(finishedAt).getTime();
	if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) {
		return null;
	}

	const durationMs = finishMs - startMs;
	return {
		durationMs,
		durationLabel: formatDurationMs(durationMs),
	};
}

function formatDurationMs(durationMs) {
	if (!Number.isFinite(durationMs) || durationMs < 0) return null;

	if (durationMs < 60 * 1000) {
		return `${Math.round(durationMs / 1000)}s`;
	}

	if (durationMs < 60 * 60 * 1000) {
		return `${(durationMs / (60 * 1000)).toFixed(2)} min`;
	}

	return `${(durationMs / (60 * 60 * 1000)).toFixed(2)} hr`;
}

function resolveUserInitials(username) {
	const normalizedUsername = String(username || '').trim().toLowerCase();
	const mappedInitials = ORDER_CANCEL_PO_INITIALS_BY_USER[normalizedUsername];

	if (mappedInitials) {
		return {
			initials: mappedInitials,
			usedFallback: false,
		};
	}

	const alphaOnlyUsername = normalizedUsername.replace(/[^a-z]/g, '');
	const fallbackInitials = (alphaOnlyUsername.slice(0, 2) || 'NA').toUpperCase();

	return {
		initials: fallbackInitials,
		usedFallback: true,
	};
}

function buildCancellationPoNumber(username) {
	const { initials, usedFallback } = resolveUserInitials(username);
	const dateLabel = new Date().toLocaleDateString('en-US', {
		timeZone: cancellationReportTimezone || 'America/Toronto',
		month: 'short',
		day: 'numeric',
	});
	return {
		value: `C&V ${initials} ${dateLabel}`,
		initials,
		usedFallback,
	};
}

function getManualRefundRoutingPaymentLabel(order) {
	const paymentSource = String(order?.payment_method || order?.method_title || '').trim();
	if (/paypal/i.test(paymentSource)) return 'PayPal';
	if (/affirm/i.test(paymentSource)) return 'Affirm';
	if (/email\s*money\s*transfer|e-?transfer|\bemt\b/i.test(paymentSource)) return 'Email Money Transfer';
	return null;
}

function parseCronProgress(lines) {
	let discoveredTotal = null;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		const processedMatch = line.match(/Processed:\s*(\d+)\/(\d+)/i);
		if (processedMatch) {
			const processed = Number(processedMatch[1]);
			const total = Number(processedMatch[2]);
			return {
				processed,
				total,
				percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
			};
		}

		const foundMatch = line.match(/Found\s+(\d+)\s+.+products with valid costs/i);
		if (!discoveredTotal && foundMatch) {
			discoveredTotal = Number(foundMatch[1]);
		}
	}

	if (discoveredTotal) {
		return {
			processed: 0,
			total: discoveredTotal,
			percent: 0,
		};
	}

	return null;
}

function summarizeCronResults(results = []) {
	if (!Array.isArray(results) || results.length === 0) return null;
	const succeeded = results.filter((result) => result.success).length;
	const failed = results.filter((result) => !result.success).length;
	return {
		total: results.length,
		succeeded,
		failed,
	};
}

function extractFailedCronResults(results = []) {
	if (!Array.isArray(results) || results.length === 0) return [];

	return results
		.filter((result) => !result?.success)
		.map((result) => ({
			cmd: result.cmd || null,
			code: result.code ?? null,
			error: result.error || null,
			logFile: result.logFile || null,
			durationMs: result.durationMs ?? null,
		}));
}

function formatFailedCronResults(failedResults = []) {
	if (!Array.isArray(failedResults) || failedResults.length === 0) return null;

	return failedResults
		.map((item) => {
			const codeText = item.code ?? 'unknown';
			const errorText = item.error ? ` (${item.error})` : '';
			return `${item.cmd || 'unknown-step'} [code ${codeText}]${errorText}`;
		})
		.join('; ');
}

function buildNotificationSnapshot(notificationResult) {
	if (!notificationResult) return null;
	return {
		success: Boolean(notificationResult.success),
		mode: notificationResult.mode,
		fallbackUsed: Boolean(notificationResult.fallbackUsed),
		message: notificationResult.error || notificationResult.message || null,
		updatedAt: new Date().toISOString(),
	};
}

function recordCronRunHistory({
	command,
	jobName,
	status,
	startedAt,
	finishedAt,
	durationMs,
	durationLabel,
	exitCode,
	error,
	notification,
	summary,
	failedResults,
}) {
	appendCronHistoryEntry({
		id: `${command}-${finishedAt || startedAt || new Date().toISOString()}`,
		command,
		jobName,
		status,
		startedAt,
		finishedAt,
		durationMs,
		durationLabel,
		exitCode,
		error: error || null,
		notification: notification || null,
		summary: summary || null,
		failedResults: Array.isArray(failedResults) ? failedResults : [],
		createdAt: new Date().toISOString(),
	});
}

function buildCronDigestResults({ lookbackHours = 24 } = {}) {
	const cutoff = Date.now() - (lookbackHours * 60 * 60 * 1000);
	const entries = readCronHistoryEntries()
		.filter((entry) => entry.command !== 'report-cron-digest-daily')
		.filter((entry) => {
			const timestamp = new Date(entry.finishedAt || entry.startedAt || entry.createdAt || 0).getTime();
			return Number.isFinite(timestamp) && timestamp >= cutoff;
		});

	if (entries.length === 0) {
		return [{
			cmd: 'No cron runs recorded',
			success: true,
			durationMs: null,
			logFile: null,
			error: null,
			logExcerpt: `No cron history entries were recorded in the last ${lookbackHours} hours.`,
		}];
	}

	const summaries = new Map();

	for (const entry of entries) {
		const key = entry.command || 'unknown';
		const current = summaries.get(key) || {
			command: key,
			jobName: entry.jobName || key,
			total: 0,
			success: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			durationMs: 0,
			errors: [],
		};

		current.total += 1;
		if (entry.status === 'success') current.success += 1;
		else if (entry.status === 'skipped') current.skipped += 1;
		else if (entry.status === 'interrupted') current.interrupted += 1;
		else current.failed += 1;

		if (Number.isFinite(entry.durationMs)) {
			current.durationMs += entry.durationMs;
		}

		if (entry.error) {
			current.errors.push(entry.error);
		}

		summaries.set(key, current);
	}

	return Array.from(summaries.values())
		.sort((left, right) => left.jobName.localeCompare(right.jobName))
		.map((summary) => {
			const hasFailures = summary.failed > 0 || summary.interrupted > 0;
			const statusLine = [
				`${summary.success} succeeded`,
				`${summary.failed} failed`,
				`${summary.skipped} skipped`,
				`${summary.interrupted} interrupted`,
			].join(', ');

			return {
				cmd: `${summary.jobName} (${summary.total} runs)`,
				success: !hasFailures,
				durationMs: summary.durationMs || null,
				logFile: null,
				error: hasFailures
					? summary.errors.slice(0, 3).join(' | ') || 'One or more runs did not complete successfully'
					: null,
				logExcerpt: statusLine,
			};
		});
}

function deriveCronArtifacts({ reportLogFile, readSummaryFile }) {
	const lines = readLogLines(reportLogFile);
	const tailLineCount = Number.isFinite(cronLogTailLines) && cronLogTailLines > 0 ? cronLogTailLines : 300;
	const recentLogLines = lines.slice(-tailLineCount);
	const lastStartLine = findLastLine(lines, (line) => /Starting .*\(npm run/.test(line));
	const lastFinishLine = findLastLine(lines, (line) => /Finished .* (exit code \d+|signal [A-Z0-9_]+)/i.test(line));
	const lastFailedToStartLine = findLastLine(lines, (line) => /Failed to start .+:/i.test(line));
	const lastErrorLine = findLastLine(lines, (line) => /❌|Error:/i.test(line));
	const lastFinishMatch = lastFinishLine?.match(/exit code\s+(\d+)/i);
	const lastSignalMatch = lastFinishLine?.match(/signal\s+([A-Z0-9_]+)/i);
	const exitCode = lastFinishMatch ? Number(lastFinishMatch[1]) : null;
	const exitSignal = lastSignalMatch ? lastSignalMatch[1] : null;
	const lastStartedAt = extractBracketTimestamp(lastStartLine);
	const lastFinishedAt = extractBracketTimestamp(lastFinishLine);
	const derivedDuration = buildDurationFromTimestamps(lastStartedAt, lastFinishedAt);
	const progress = parseCronProgress(lines);
	const summary = readJsonFileSafe(readSummaryFile);
	const resultSummary = summarizeCronResults(summary?.results);
	const failedResults = extractFailedCronResults(summary?.results);

	let status = null;
	if (lastFinishMatch || lastSignalMatch) {
		status = exitCode === 0 ? 'success' : 'failed';
	} else if (lastFailedToStartLine) {
		status = 'failed';
	} else if (lastStartLine) {
		status = 'interrupted';
	}

	return {
		status,
		lastStartedAt,
		lastFinishedAt,
		lastDurationMs: derivedDuration?.durationMs || null,
		lastDurationLabel: derivedDuration?.durationLabel || null,
		lastExitCode: exitCode,
		exitSignal,
		lastError: lastErrorLine || null,
		progress,
		recentLogLines,
		summary: resultSummary,
		failedResults,
	};
}

function buildCronJobStatus(definition, historyEntries = null) {
	const live = cronJobRegistry.get(definition.command) || {};
	const artifacts = deriveCronArtifacts(definition);
	const fileHistory = getRecentCronHistoryForCommand(definition.command, historyEntries);
	const history = fileHistory.length > 0
		? fileHistory
		: deriveHistoryFromLogLines(definition, readLogLines(definition.reportLogFile));
	const latestHistory = history[0] || null;
	const isRunning = Boolean(live.isRunning);
	const persistedStatus = live.lastStatus && !['scheduled', 'disabled'].includes(live.lastStatus)
		? live.lastStatus
		: null;
	const status = isRunning
		? 'running'
		: persistedStatus || artifacts.status || live.lastStatus || (cronEnabled ? 'scheduled' : 'disabled');

	return {
		id: definition.command,
		command: definition.command,
		jobName: definition.jobName,
		schedule: definition.schedule,
		timezone: definition.timezone || cronTimezone,
		logFile: definition.reportLogFile ? path.resolve(__dirname, definition.reportLogFile) : null,
		status,
		isRunning,
		lastStartedAt: live.lastStartedAt || artifacts.lastStartedAt || latestHistory?.startedAt || null,
		lastFinishedAt: live.lastFinishedAt || artifacts.lastFinishedAt || latestHistory?.finishedAt || null,
		lastDurationMs: live.lastDurationMs || latestHistory?.durationMs || artifacts.lastDurationMs || null,
		lastDurationLabel: live.lastDurationLabel || latestHistory?.durationLabel || artifacts.lastDurationLabel || null,
		lastExitCode: live.lastExitCode ?? artifacts.lastExitCode ?? null,
		lastError: live.lastError || artifacts.lastError || latestHistory?.error || null,
		lastNotification: live.lastNotification || latestHistory?.notification || null,
		progress: isRunning ? (artifacts.progress || live.progress || null) : (live.progress || artifacts.progress || null),
		summary: live.summary || artifacts.summary || latestHistory?.summary || null,
		failedResults: live.failedResults || artifacts.failedResults || latestHistory?.failedResults || [],
		recentLogLines: artifacts.recentLogLines,
		history,
		updatedAt: live.updatedAt || null,
	};
}

// 🔐 Import authentication components (safe - disabled by default)
const authRoutes = require('./routes/auth');
const { authenticateToken, optionalAuth } = require('./middleware/auth');

function scheduleQuickBooksLookupPreload() {
	if (isQuickBooksDbSource()) {
		logger.info('QuickBooks lookup preload skipped: QB_LOOKUP_SOURCE=db (data served from Postgres)');
		return;
	}

	if (!quickBooksPreloadEnabled) {
		logger.info('QuickBooks lookup preload disabled via QB_LOOKUP_PRELOAD_ON_BOOT=false');
		return;
	}

	setTimeout(async () => {
		try {
			loadQuickBooksLookupData();
			logger.info('QuickBooks customer lookup data loaded', await getQuickBooksLookupMeta());
		} catch (error) {
			logger.error('QuickBooks customer lookup data failed to preload', {
				error: error.message,
			});
		}
	}, quickBooksPreloadDelayMs);
}

// Use cors middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173", // local frontend
			"http://127.0.0.1:5173", // local frontend (loopback)
      "https://lionfish-app-v8v9s.ondigitalocean.app", // production frontend (old)
      "https://pricingtool.justjeeps.com", // production frontend (custom domain)
    ],
    credentials: true,
  })
);

// app.use(cors()); // Old permissive CORS - now replaced with specific origins

app.use(compression());

// Express Configuration
app.use(BodyParser.urlencoded({ extended: false, limit: '10mb' }));
app.use(BodyParser.json({ limit: '10mb' }));
app.use(Express.static('public'));

// Request logging middleware (Axiom)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Only log non-health-check requests to reduce noise
    if (req.path !== '/api/health') {
      logger.request(req, res, duration);
    }
  });
  next();
});

// 🔐 Authentication routes (safe - disabled by default via ENABLE_AUTH=false)
app.use('/api/auth', authRoutes);

// Health check endpoint para Kamal/Load Balancer
app.get('/api/health', async (req, res) => {
	// Liveness endpoint: stays healthy while process is running.
	res.status(200).json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
	});
});

// Readiness endpoint with DB check for diagnostics/monitoring.
app.get('/api/health/db', async (req, res) => {
	try {
		await prisma.$queryRaw`SELECT 1`;
		res.status(200).json({
			status: 'healthy',
			dependencies: {
				database: 'up',
			},
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
		});
	} catch (error) {
		res.status(503).json({
			status: 'degraded',
			dependencies: {
				database: 'down',
			},
			error: 'Database connection failed',
			timestamp: new Date().toISOString(),
		});
	}
});

// Sample GET route
app.get('/', (req, res) =>
	res.json({
		message: 'Seems to work!',
	})
);

// 🔐 Apply authentication middleware to all routes below this point
// Public routes: /api/auth/*, /api/health, /
// Protected routes: all other /api/* routes
app.use('/api', authenticateToken);

// Sample GET route
app.get('/api/data', (req, res) =>
	res.json({
		message: '/api/data route works!',
	})
);

app.get('/api/quickbooks/customers/search', async (req, res) => {
	try {
		const query = req.query.q || req.query.query || '';
		const field = req.query.field || 'all';
		const limit = Number(req.query.limit || 20);
		const page = Number(req.query.page || 1);
 		const sortBy = req.query.sortBy || 'customerName';
		const sortOrder = req.query.sortOrder || 'asc';

		const payload = await queryQuickBooksCustomers({ query, field, limit, page, sortBy, sortOrder });
		const results = payload.results || [];
		return res.json({
			query,
			field,
			sortBy: payload.sortBy,
			sortOrder: payload.sortOrder,
			page: payload.page,
			limit: payload.limit,
			total: payload.total,
			count: results.length,
			results,
		});
	} catch (error) {
		logger.error('QuickBooks customer search failed', {
			error: error.message,
		});
		return res.status(500).json({ error: 'Failed to search QuickBooks customers' });
	}
});

app.get('/api/quickbooks/customers/details', async (req, res) => {
	try {
		const customerCode = String(req.query.customerCode || '').trim();

		if (!customerCode) {
			return res.status(400).json({ error: 'Missing required query parameter: customerCode' });
		}

		const customer = await getQuickBooksCustomerDetails(customerCode);
		if (!customer) {
			return res.status(404).json({ error: 'Customer not found' });
		}

		return res.json(customer);
	} catch (error) {
		logger.error('QuickBooks customer detail fetch failed', {
			error: error.message,
		});
		return res.status(500).json({ error: 'Failed to fetch QuickBooks customer details' });
	}
});

app.get('/api/quickbooks/customers/meta', async (req, res) => {
	try {
		const meta = await getQuickBooksLookupMeta();
		return res.json(meta);
	} catch (error) {
		logger.error('QuickBooks customer meta fetch failed', {
			error: error.message,
		});
		return res.status(500).json({ error: 'Failed to fetch QuickBooks lookup metadata' });
	}
});

app.get('/api/cron-jobs', (req, res) => {
	try {
		const historyEntries = readCronHistoryEntries();
		const jobs = getCronDashboardDefinitions().map((definition) => buildCronJobStatus(definition, historyEntries));
		res.json({
			jobs,
			generatedAt: new Date().toISOString(),
			cronEnabled,
			timezone: cronTimezone,
			historyLookbackDays: cronHistoryLookbackDays,
		});
	} catch (error) {
		logger.error('Failed to build cron job status response', {
			error: error.message,
		});
		res.status(500).json({ error: 'Failed to fetch cron job status' });
	}
});

app.get('/api/cron-jobs/:command/log-lines', (req, res) => {
	try {
		const command = String(req.params.command || '').trim();
		if (!command) {
			return res.status(400).json({ error: 'Missing command parameter' });
		}

		const definition = getCronJobDefinitionByCommand(command);
		if (!definition?.reportLogFile) {
			return res.status(404).json({ error: `No log file configured for command ${command}` });
		}

		const requestedLines = Number(req.query.lines);
		const lineCount = Number.isFinite(requestedLines) && requestedLines > 0
			? Math.min(5000, Math.floor(requestedLines))
			: 400;
		const lines = readLogLines(definition.reportLogFile);

		return res.json({
			command,
			jobName: definition.jobName,
			logFile: path.resolve(__dirname, definition.reportLogFile),
			lineCount,
			lines: lines.slice(-lineCount),
			updatedAt: new Date().toISOString(),
		});
	} catch (error) {
		logger.error('Failed to fetch cron log lines', {
			command: req.params?.command,
			error: error.message,
		});
		return res.status(500).json({ error: 'Failed to fetch cron log lines' });
	}
});

app.post('/api/reports/purchaser/email', async (req, res) => {
	try {
		const { report, date, initials } = req.body || {};
		if (!report || !date) {
			return res.status(400).json({ error: 'Missing report or date' });
		}

		if (process.env.ENABLE_AUTH === 'true' && req.user) {
			const allowed = ['tess', 'paula', 'karoline'];
			const username = (req.user.username || req.user.firstname || '').toLowerCase();
			if (!allowed.includes(username)) {
				return res.status(403).json({ error: 'Not authorized to send report' });
			}
		}

		const result = await sendPurchaserReportEmail({
			report,
			dateStr: date,
			initials,
		});

		if (!result?.success) {
			return res.status(500).json({ error: result?.error || 'Failed to send email' });
		}

		return res.json({ success: true });
	} catch (error) {
		console.error('Failed to send purchaser report email:', error);
		return res.status(500).json({ error: 'Failed to send email' });
	}
});

app.post('/api/reports/order-cancellations/daily/email', async (req, res) => {
	try {
		const { date } = req.body || {};
		const requestedDate = String(date || '').trim();
		const reportDate = requestedDate || getDateStringInTimezone(new Date(), cancellationReportTimezone || 'America/Toronto');

		if (process.env.ENABLE_AUTH === 'true' && req.user) {
			const allowed = ['admin', 'tess', 'jerry', 'jacob', 'paula', 'karoline'];
			const username = (req.user.username || req.user.firstname || '').toLowerCase();
			if (!allowed.includes(username)) {
				return res.status(403).json({ error: 'Not authorized to send cancellation report' });
			}
		}

		const result = await sendDailyCancellationReportEmailForDate(reportDate, {
			timeZone: cancellationReportTimezone,
		});

		return res.json({
			success: true,
			reportDate,
			totalCancelled: result.report.totalCancelled,
			paulaCancelled: result.report.paulaCancelled,
			byUser: result.report.byUser,
			recipients: process.env.ORDER_CANCELLATION_REPORT_EMAILS || process.env.CRON_NOTIFICATION_EMAIL || '',
		});
	} catch (error) {
		logger.error('Failed to send daily cancellation report email', {
			error: error.message,
			requestedDate: req.body?.date || null,
		});
		return res.status(500).json({ error: 'Failed to send daily cancellation report email' });
	}
});

app.post('/api/reports/sku-status/daily/email', async (req, res) => {
	try {
		const { date } = req.body || {};
		const requestedDate = String(date || '').trim();
		const reportDate = requestedDate || getDateStringInTimezone(new Date(), skuStatusReportTimezone || 'America/Toronto');

		if (process.env.ENABLE_AUTH === 'true' && req.user) {
			const username = (req.user.username || req.user.firstname || '').toLowerCase();
			if (!MAGENTO_STATUS_ALLOWED_USERS.has(username)) {
				return res.status(403).json({ error: 'Not authorized to send SKU status report' });
			}
		}

		const result = await sendDailySkuStatusReportEmailForDate(reportDate, {
			timeZone: skuStatusReportTimezone,
		});

		return res.json({
			success: true,
			reportDate,
			totalChanged: result.report.totalChanged,
			totalDisabled: result.report.totalDisabled,
			totalEnabled: result.report.totalEnabled,
			byUser: result.report.byUser,
			recipients: process.env.SKU_STATUS_REPORT_EMAILS || process.env.CRON_NOTIFICATION_EMAIL || '',
		});
	} catch (error) {
		logger.error('Failed to send daily SKU status report email', {
			error: error.message,
			requestedDate: req.body?.date || null,
		});
		return res.status(500).json({ error: 'Failed to send daily SKU status report email' });
	}
});

app.post('/api/reports/sku-status/weekly/email', async (req, res) => {
	try {
		const { endDate } = req.body || {};
		const requestedEndDate = String(endDate || '').trim();
		const reportEndDate = requestedEndDate || getDateStringInTimezone(new Date(), skuStatusWeeklyReportTimezone || 'America/Toronto');

		if (process.env.ENABLE_AUTH === 'true' && req.user) {
			const username = (req.user.username || req.user.firstname || '').toLowerCase();
			if (!MAGENTO_STATUS_ALLOWED_USERS.has(username)) {
				return res.status(403).json({ error: 'Not authorized to send SKU status report' });
			}
		}

		const result = await sendWeeklySkuStatusReportEmailForDate(reportEndDate, {
			timeZone: skuStatusWeeklyReportTimezone,
		});

		return res.json({
			success: true,
			reportStartDate: result.report.startDate,
			reportEndDate: result.report.endDate,
			totalChanged: result.report.totalChanged,
			totalDisabled: result.report.totalDisabled,
			totalEnabled: result.report.totalEnabled,
			byUser: result.report.byUser,
			recipients: process.env.SKU_STATUS_WEEKLY_REPORT_EMAILS || process.env.SKU_STATUS_REPORT_EMAILS || process.env.CRON_NOTIFICATION_EMAIL || '',
		});
	} catch (error) {
		logger.error('Failed to send weekly SKU status report email', {
			error: error.message,
			requestedEndDate: req.body?.endDate || null,
		});
		return res.status(500).json({ error: 'Failed to send weekly SKU status report email' });
	}
});

// Route for getting all wheelPros products
app.get('/api/wheelPros', async (req, res) => {
  try {
    const skus = await getWheelProsSkus();
    const allResults = await makeApiRequestsInChunks(skus, 50);
    res.json(allResults);
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch products ${error}` });
  }
});


// Route for getting all Quadratec products
app.get('/api/quadratec', async (req, res) => {
	try {
		const products = await quadratecProducts();
		res.json(products);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});


// Route for getting top 5 products by qty_ordered
app.get('/top5skus', async (req, res) => {
	try {
		const top5Skus = await prisma.orderProduct.groupBy({
			by: ['sku'],
			_sum: {
				qty_ordered: true,
			},
			orderBy: {
				_sum: {
					qty_ordered: 'desc',
				},
			},
			take: 10,
		});

		const top5SkusWithProducts = await Promise.all(
			top5Skus.map(async orderProduct => {
				const product = await prisma.product.findUnique({
					where: {
						sku: orderProduct.sku,
					},
				});
				return {
					...orderProduct,
					product,
				};
			})
		);

		res.json(top5SkusWithProducts);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: `${error}` });
	}
});

//Route for getting all products sku, only return the id
app.get('/api/products_sku', async (req, res) => {
	try {
		const products = await prisma.product.findMany({
			select: {
				sku: true,
			},
			take: 20001,
		});
		res.json(products);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});

// GET /api/products/:sku/brand  →  { brand: "Lube Locker" }
app.get('/api/products/:sku/brand', async (req, res) => {
  try {
    const p = await prisma.product.findUnique({
      where: { sku: req.params.sku },
      select: { brand_name: true },
    });
    res.json({ brand: p?.brand_name || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch brand' });
  }
});


//Route for getting all products (with pagination)
app.get('/api/products', async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 50;
		const skip = (page - 1) * limit;
		const search = req.query.search || '';

		// Build where clause for search
		const where = search ? {
			OR: [
				{ sku: { contains: search, mode: 'insensitive' } },
				{ name: { contains: search, mode: 'insensitive' } },
				{ brand_name: { contains: search, mode: 'insensitive' } },
				{ searchable_sku: { contains: search, mode: 'insensitive' } },
			]
		} : {};

		const selectFields = {
			sku: true,
			name: true,
			url_path: true,
			status: true,
			price: true,
			MAP: true,
			replace_oe: true,
			searchable_sku: true,
			jj_prefix: true,
			image: true,
			brand_name: true,
			vendors: true,
			partStatus_meyer: true,
			keystone_code: true,
			meyer_weight: true,
			meyer_length: true,
			meyer_width: true,
			meyer_height: true,
			weight: true,
			length: true,
			width: true,
			height: true,
			black_friday_sale: true,
			shippingFreight: true,
			partsEngine_code: true,
			tdot_url: true,
			keystone_code_site: true,
			part: true,
			thumbnail: true,
			vendorProducts: {
				select: {
					product_sku: true,
					vendor_sku: true,
					vendor_cost: true,
					vendor_cost_usd: true,
					quadratec_shipping_surcharge_usd: true,
					vendor_inventory: true,
					vendor_inventory_string: true,
					partStatus_meyer: true,
					quadratec_sku: true,
					vendor: {
						select: {
							name: true,
						},
					},
				},
			},
			competitorProducts: {
				select: {
					competitor_price: true,
					product_url: true,
					competitor: {
						select: {
							name: true,
						},
					},
				},
			},
		};

		// Run query and count in parallel for better performance
		const [products, total] = await Promise.all([
			prisma.product.findMany({
				where,
				skip,
				take: limit,
				select: selectFields,
			}),
			prisma.product.count({ where })
		]);

		const partLookup = await getMagentoPartLabelLookup();
		const mappedProducts = mapProductsPartLabels(products, partLookup);

		res.json({
			products: mappedProducts,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
				hasMore: page * limit < total
			}
		});
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});

// Route for exporting all products (no pagination) - optimized for Excel export
app.get('/api/products/export', async (req, res) => {
	try {
		const brand = req.query.brand ? decodeURIComponent(req.query.brand) : null;
		const useLivePrice = !['0', 'false', 'no'].includes(
			String(req.query.livePrice ?? '0').toLowerCase()
		);
		const livePriceStoreId = Number.isInteger(Number(req.query.livePriceStoreId))
			? Number(req.query.livePriceStoreId)
			: 1;

		// Build where clause for brand filter
		const where = brand ? { brand_name: brand } : {};

		const selectFields = {
			sku: true,
			name: true,
			url_path: true,
			status: true,
			price: true,
			MAP: true,
			replace_oe: true,
			searchable_sku: true,
			jj_prefix: true,
			image: true,
			brand_name: true,
			vendors: true,
			partStatus_meyer: true,
			keystone_code: true,
			meyer_weight: true,
			meyer_length: true,
			meyer_width: true,
			meyer_height: true,
			black_friday_sale: true,
			weight: true,
			length: true,
			width: true,
			height: true,
			shippingFreight: true,
			partsEngine_code: true,
			tdot_url: true,
			part: true,
			thumbnail: true,
			vendorProducts: {
				select: {
					product_sku: true,
					vendor_sku: true,
					vendor_cost: true,
					vendor_cost_usd: true,
					quadratec_shipping_surcharge_usd: true,
					vendor_inventory: true,
					quadratec_sku: true,
					vendor: {
						select: {
							name: true,
						},
					},
				},
			},
			competitorProducts: {
				select: {
					competitor_price: true,
					product_url: true,
					competitor: {
						select: {
							name: true,
						},
					},
				},
			},
		};

		const products = await prisma.product.findMany({
			where,
			select: selectFields,
		});

		const partLookup = await getMagentoPartLabelLookup();
		const mappedProducts = mapProductsPartLabels(products, partLookup);

		let exportProducts = mappedProducts;
		let livePriceStats = {
			requested: 0,
			resolved: 0,
			failedBatches: 0,
			storeId: livePriceStoreId,
			enabled: false,
		};

		if (useLivePrice && process.env.MAGENTO_KEY) {
			const {
				bySku,
				requestedSkuCount,
				resolvedSkuCount,
				failedBatches,
			} = await fetchMagentoBasePricesBySkus({
				skus: mappedProducts.map((product) => product.sku),
				storeId: livePriceStoreId,
			});

			exportProducts = mappedProducts.map((product) => {
				const livePrice = bySku.get(product.sku);
				const hasLivePrice = Number.isFinite(livePrice);
				return {
					...product,
					price_db: product.price,
					price: hasLivePrice ? livePrice : product.price,
					price_source: hasLivePrice ? `magento_store_${livePriceStoreId}` : 'db',
				};
			});

			livePriceStats = {
				requested: requestedSkuCount,
				resolved: resolvedSkuCount,
				failedBatches,
				storeId: livePriceStoreId,
				enabled: true,
			};
		}

		res.json({
			products: exportProducts,
			total: exportProducts.length,
			brand: brand || 'all',
			livePrice: livePriceStats,
		});
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to export products' });
	}
});

// Route for downloading specific source files used by seed updates
app.get('/api/files/download/:fileKey', (req, res) => {
	try {
		const fileKey = req.params.fileKey;
		const fileMap = {
			'quad-price': {
				path: path.join(__dirname, 'prisma/seeds/api-calls/pricingSheet_quad.xlsx'),
				name: 'pricingSheet_quad.xlsx',
			},
			'keystone-instock-price': {
				path: path.join(__dirname, 'prisma/seeds/api-calls/keystone_files/Inventory.csv'),
				name: 'keystone_instock_inventory.csv',
			},
			'keystone-special-order-price': {
				path: path.join(__dirname, 'prisma/seeds/api-calls/keystone_files/Inventory.csv'),
				name: 'keystone_special_order_inventory.csv',
			},
		};

		const fileConfig = fileMap[fileKey];
		if (!fileConfig) {
			return res.status(404).json({ error: 'File key not found' });
		}

		if (!fs.existsSync(fileConfig.path)) {
			return res.status(404).json({ error: 'File not found on server' });
		}

		return res.download(fileConfig.path, fileConfig.name);
	} catch (error) {
		console.error('File download failed:', error);
		return res.status(500).json({ error: 'Failed to download file' });
	}
});

//Route for getting all products by brand name
app.get('/api/products/brand/:brandName', async (req, res) => {
	try {
		const brandName = decodeURIComponent(req.params.brandName);

		const products = await prisma.product.findMany({
			where: {
				brand_name: brandName,
				status: 1,
				price: { gt: 0 }
			},
			select: {
				sku: true,
				name: true,
				url_path: true,
				status: true,
				price: true,
				MAP: true,
				replace_oe: true,
				searchable_sku: true,
				jj_prefix: true,
				image: true,
				brand_name: true,
				vendors: true,
				partStatus_meyer: true,
				keystone_code: true,
				meyer_weight: true,
				meyer_length: true,
				meyer_width: true,
				meyer_height: true,
				weight: true,
				length: true,
				width: true,
				height: true,
				black_friday_sale: true,
				shippingFreight: true,
				partsEngine_code: true,
				tdot_url: true,
				keystone_code_site: true,
				part: true,
				thumbnail: true,
				vendorProducts: {
					select: {
						product_sku: true,
						vendor_sku: true,
						vendor_cost: true,
						vendor_cost_usd: true,
						quadratec_shipping_surcharge_usd: true,
						vendor_inventory: true,
						vendor_inventory_string: true,
						partStatus_meyer: true,
						quadratec_sku: true,
						vendor: {
							select: {
								name: true,
							},
						},
					},
				},
				competitorProducts: {
					select: {
						competitor_price: true,
						product_url: true,
						competitor: {
							select: {
								name: true,
							},
						},
					},
				},
			},
		});

		const partLookup = await getMagentoPartLabelLookup();
		const mappedProducts = mapProductsPartLabels(products, partLookup);

		res.json(mappedProducts);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch products by brand' });
	}
});

//Route for getting all products by sku
app.get('/api/products/:sku', async (req, res) => {
	try {
		const product = await prisma.product.findUnique({
			where: {
				sku: req.params.sku,
			},
			select: {
				sku: true,
				name: true,
				url_path: true,
				status: true,
				price: true,
				MAP: true,
				replace_oe: true,
				searchable_sku: true,
				jj_prefix: true,
				image: true,
				brand_name: true,
				vendors: true,
				partStatus_meyer: true,
				keystone_code: true,
				//add meyer_weight, meyer_length, meyer_width, meyer_height
				meyer_weight: true,
				meyer_length: true,
				meyer_width: true,
				meyer_height: true,
				black_friday_sale: true,
				weight: true,
				length: true,
				width: true,
				height: true,
				shippingFreight: true,
				partsEngine_code: true,
				tdot_url: true,
				keystone_code_site: true,
				part: true,
				thumbnail: true,
				vendorProducts: {
					select: {
						product_sku: true,
						vendor_sku: true,
						vendor_cost: true,
						vendor_cost_usd: true,
						quadratec_shipping_surcharge_usd: true,
						vendor_inventory: true,
						vendor_inventory_string: true,
						quadratec_sku: true,
						vendor: {
							select: {
								name: true,
							},
						},
					},
				},
				competitorProducts: {
					select: {
						competitor_price: true,
						product_url: true,
						competitor: {
							select: {
								name: true,
							},
						},
					},
				},
			},
		});

		const partLookup = await getMagentoPartLabelLookup();
		const mappedProduct = mapProductPartLabel(product, partLookup);

		res.json(mappedProduct);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch product' });
	}
});

function resolveMagentoBaseUrl() {
	const configured = (
		process.env.MAGENTO_BASE_URL ||
		process.env.M2_BASE_URL ||
		'https://www.justjeeps.com'
	).trim();

	if (!configured) {
		return 'https://www.justjeeps.com';
	}

	const restMarker = '/rest/';
	const markerIndex = configured.indexOf(restMarker);
	if (markerIndex >= 0) {
		return configured.slice(0, markerIndex);
	}

	return configured.replace(/\/$/, '');
}

function chunkArray(items, size) {
	const safeSize = Number(size) > 0 ? Number(size) : 500;
	const out = [];
	for (let i = 0; i < items.length; i += safeSize) {
		out.push(items.slice(i, i + safeSize));
	}
	return out;
}

async function fetchMagentoBasePricesBySkus({ skus, storeId = 1 }) {
	const token = process.env.MAGENTO_KEY;
	const normalizedStoreId = Number.isInteger(Number(storeId)) ? Number(storeId) : 1;
	const uniqueSkus = Array.from(
		new Set((skus || []).map((v) => String(v || '').trim()).filter(Boolean))
	);

	if (!token || uniqueSkus.length === 0) {
		return {
			bySku: new Map(),
			requestedSkuCount: uniqueSkus.length,
			resolvedSkuCount: 0,
			failedBatches: 0,
		};
	}

	const bySku = new Map();
	let failedBatches = 0;
	const magentoBaseUrl = resolveMagentoBaseUrl();
	const endpoint = `${magentoBaseUrl}/rest/default/V1/products/base-prices-information`;
	const batches = chunkArray(uniqueSkus, Number(process.env.MAGENTO_PRICE_LOOKUP_BATCH || 500));

	for (const batch of batches) {
		try {
			const response = await axios.post(
				endpoint,
				{ skus: batch },
				{
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 20000),
				}
			);

			const rows = Array.isArray(response.data) ? response.data : [];
			for (const row of rows) {
				const sku = String(row?.sku || '').trim();
				const rowStoreId = Number(row?.store_id);
				const price = Number(row?.price);
				if (!sku || rowStoreId !== normalizedStoreId || !Number.isFinite(price)) continue;
				bySku.set(sku, price);
			}
		} catch (error) {
			failedBatches += 1;
			logger.warn('Magento base-prices-information lookup batch failed during export', {
				status: error.response?.status || null,
				message: error.response?.data?.message || error.message,
				batchSize: batch.length,
			});
		}
	}

	return {
		bySku,
		requestedSkuCount: uniqueSkus.length,
		resolvedSkuCount: bySku.size,
		failedBatches,
	};
}

async function setMagentoProductStatusByStoreView({ baseUrl, token, sku, status, storeViewCode }) {
	const encodedSku = encodeURIComponent(sku);
	const endpoint = `${baseUrl}/rest/${storeViewCode}/V1/products/${encodedSku}`;
	const payload = { product: { status } };
	const requestConfig = {
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
	};

	try {
		const response = await axios.put(endpoint, payload, requestConfig);
		return {
			storeViewCode,
			success: true,
			method: 'PUT',
			statusCode: response.status,
		};
	} catch (putError) {
		if (putError.response?.status === 405) {
			try {
				const response = await axios.post(endpoint, payload, requestConfig);
				return {
					storeViewCode,
					success: true,
					method: 'POST',
					statusCode: response.status,
				};
			} catch (postError) {
				return {
					storeViewCode,
					success: false,
					statusCode: postError.response?.status || null,
					error: postError.response?.data || postError.message,
				};
			}
		}

		return {
			storeViewCode,
			success: false,
			statusCode: putError.response?.status || null,
			error: putError.response?.data || putError.message,
		};
	}
}

async function getMagentoConfigurableChildSkus({ baseUrl, token, sku }) {
	const encodedSku = encodeURIComponent(sku);
	const endpoint = `${baseUrl}/rest/V1/configurable-products/${encodedSku}/children`;

	try {
		const response = await axios.get(endpoint, buildMagentoRequestConfig(token));
		const children = Array.isArray(response.data) ? response.data : [];
		return children
			.map((child) => (child?.sku || '').trim())
			.filter(Boolean);
	} catch (error) {
		const statusCode = error.response?.status || null;
		if (statusCode !== 404) {
			logger.warn('Failed to fetch Magento configurable children', {
				sku,
				statusCode,
				error: error.response?.data || error.message,
			});
		}

		return [];
	}
}

async function setProductStatusAcrossAllStoreViews(req, res, forcedStatus = null) {
	try {
		if (process.env.ENABLE_AUTH !== 'true') {
			return res.status(403).json({
				error: 'Feature locked',
				message: 'SKU status changes require authentication to be enabled',
			});
		}

		const requesterUsername = (req.user?.username || '').toLowerCase();
		if (!MAGENTO_STATUS_ALLOWED_USERS.has(requesterUsername)) {
			return res.status(403).json({
				error: 'Forbidden',
				message: 'You are not authorized to change SKU status',
			});
		}

		const sku = (req.params.sku || '').trim();
		if (!sku) {
			return res.status(400).json({ error: 'SKU is required' });
		}

		const normalizedSku = sku.replace(/-+$/, '');
		const shouldApplyToChildren = Boolean(req.body?.applyToChildren) || sku.endsWith('-');
		const shouldUseLocalFamilyFallback = sku.endsWith('-');

		const token = process.env.MAGENTO_KEY;
		if (!token) {
			return res.status(500).json({ error: 'MAGENTO_KEY is not configured' });
		}

		const magentoBaseUrl = resolveMagentoBaseUrl();
		let targetSkus = [];
		let targetProducts = [];
		if (shouldApplyToChildren) {
			const magentoChildSkus = await getMagentoConfigurableChildSkus({
				baseUrl: magentoBaseUrl,
				token,
				sku,
			});

			if (magentoChildSkus.length > 0) {
				targetSkus = Array.from(new Set([sku, ...magentoChildSkus]));
			}
		}

		if (shouldApplyToChildren && shouldUseLocalFamilyFallback && targetSkus.length === 0) {
			targetProducts = await prisma.product.findMany({
				where: {
					sku: {
						startsWith: normalizedSku,
						mode: 'insensitive',
					},
				},
				select: { sku: true },
			});
		} else if (!shouldApplyToChildren || targetSkus.length === 0) {
			const productExists = await prisma.product.findUnique({
				where: { sku },
				select: { sku: true },
			});

			if (productExists) {
				targetProducts = [productExists];
			}
		}

		if (targetSkus.length === 0) {
			targetSkus = Array.from(new Set(targetProducts.map((product) => product.sku)));
		}

		if (!targetSkus.length) {
			const targetLabel = shouldApplyToChildren
				? `Product family with prefix ${normalizedSku}`
				: `Product with SKU ${sku}`;
			return res.status(404).json({ error: `${targetLabel} not found` });
		}

		const requestedStatus = forcedStatus ?? Number(req.body?.status);
		if (![1, 2].includes(requestedStatus)) {
			return res.status(400).json({ error: 'Invalid status. Use 1 (enabled) or 2 (disabled).' });
		}

		const statusToSet = requestedStatus;
		const storeViewsEndpoint = `${magentoBaseUrl}/rest/V1/store/storeViews`;

		let discoveredStoreViews = [];
		try {
			const storeViewsResponse = await axios.get(storeViewsEndpoint, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/json',
				},
				timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
			});

			discoveredStoreViews = Array.isArray(storeViewsResponse.data)
				? storeViewsResponse.data
				: [];
		} catch (storeViewError) {
			logger.warn('Failed to discover Magento store views, falling back to all/default', {
				sku,
				error: storeViewError.message,
			});
		}

		const storeViewCodes = [
			'all',
			...discoveredStoreViews
				.map((view) => (view?.code || '').trim())
				.filter((code) => code && code.toLowerCase() !== 'admin'),
		];

		const uniqueStoreViewCodes = Array.from(new Set(storeViewCodes));

		const perSkuResults = await Promise.all(
			targetSkus.map(async (targetSku) => {
				const results = await Promise.all(
					uniqueStoreViewCodes.map((storeViewCode) =>
						setMagentoProductStatusByStoreView({
							baseUrl: magentoBaseUrl,
							token,
							sku: targetSku,
							status: statusToSet,
							storeViewCode,
						})
					)
				);

				const successfulUpdates = results.filter((result) => result.success);
				const failedUpdates = results.filter((result) => !result.success);

				if (successfulUpdates.length > 0) {
					await prisma.product.updateMany({
						where: { sku: targetSku },
						data: { status: statusToSet },
					});
				}

				return {
					sku: targetSku,
					success: successfulUpdates.length > 0,
					updatedStoreViews: successfulUpdates.map((entry) => entry.storeViewCode),
					failedStoreViews: failedUpdates,
					results,
				};
			})
		);

		const successfulSkuUpdates = perSkuResults.filter((entry) => entry.success);
		const failedSkuUpdates = perSkuResults.filter((entry) => !entry.success);
		const updatedStoreViews = Array.from(
			new Set(successfulSkuUpdates.flatMap((entry) => entry.updatedStoreViews || []))
		);
		const failedStoreViews = failedSkuUpdates.flatMap((entry) => entry.failedStoreViews || []);

		if (successfulSkuUpdates.length === 0) {
			return res.status(502).json({
				error: 'Failed to update SKU status in Magento store views for all target SKUs',
				sku,
				status: statusToSet,
				targetSkus,
				perSkuResults,
			});
		}

		const successfulSkus = successfulSkuUpdates.map((entry) => entry.sku).filter(Boolean);
		try {
			const productsForReport = await prisma.product.findMany({
				where: { sku: { in: successfulSkus } },
				select: { sku: true, name: true },
			});
			const titleBySku = new Map(
				productsForReport.map((product) => [String(product.sku || '').toLowerCase(), product.name || ''])
			);
			const recordedAt = new Date();
			const recordedAtIso = recordedAt.toISOString();
			const historyEntries = successfulSkuUpdates.map((entry) => ({
				recordedAt,
				reportDate: getDateStringInTimezone(recordedAt, skuStatusReportTimezone || 'America/Toronto'),
				timeZone: skuStatusReportTimezone || 'America/Toronto',
				changedBy: requesterUsername,
				changedByName: getUserDisplayName(req.user),
				changedByEmail: req.user?.email || '',
				source: normalizeSkuStatusReportSource(req.body?.source),
				requestedSku: sku,
				sku: entry.sku,
				title: titleBySku.get(String(entry.sku || '').toLowerCase()) || '',
				status: statusToSet,
				action: statusToSet === 2 ? 'disabled' : 'enabled',
				applyToChildren: shouldApplyToChildren,
				updatedStoreViews: entry.updatedStoreViews || [],
				failedStoreViews: entry.failedStoreViews || [],
			}));
			await prisma.skuStatusChangeHistory.createMany({
				data: historyEntries.map(mapSkuStatusHistoryEntryToDbRow),
				skipDuplicates: true,
			});
			appendSkuStatusHistoryEntries(historyEntries.map((entry) => ({
				...entry,
				recordedAt: recordedAtIso,
			})));
		} catch (historyError) {
			try {
				appendSkuStatusHistoryEntries((successfulSkuUpdates || []).map((entry) => ({
					recordedAt: new Date().toISOString(),
					reportDate: getDateStringInTimezone(new Date(), skuStatusReportTimezone || 'America/Toronto'),
					timeZone: skuStatusReportTimezone || 'America/Toronto',
					changedBy: requesterUsername,
					changedByName: getUserDisplayName(req.user),
					changedByEmail: req.user?.email || '',
					source: normalizeSkuStatusReportSource(req.body?.source),
					requestedSku: sku,
					sku: entry.sku,
					title: '',
					status: statusToSet,
					action: statusToSet === 2 ? 'disabled' : 'enabled',
					applyToChildren: shouldApplyToChildren,
					updatedStoreViews: entry.updatedStoreViews || [],
					failedStoreViews: entry.failedStoreViews || [],
				})));
			} catch (fallbackError) {
				logger.error('Failed to record fallback SKU status report history', {
					sku,
					status: statusToSet,
					error: fallbackError.message,
				});
			}
			logger.error('Failed to record SKU status report history', {
				sku,
				status: statusToSet,
				error: historyError.message,
			});
		}

		return res.json({
			success: true,
			sku,
			status: statusToSet,
			applyToChildren: shouldApplyToChildren,
			targetSkus,
			updatedStoreViews,
			failedStoreViews,
			perSkuResults,
		});
	} catch (error) {
		logger.error('Failed to set SKU status across all store views', {
			error: error.message,
			sku: req.params?.sku,
		});
		return res.status(500).json({ error: 'Failed to update SKU status across all store views' });
	}
}

app.post('/api/products/:sku/disable-all-store-views', async (req, res) => {
	return setProductStatusAcrossAllStoreViews(req, res, 2);
});

app.post('/api/products/:sku/status-all-store-views', async (req, res) => {
	return setProductStatusAcrossAllStoreViews(req, res);
});

function buildMagentoRequestConfig(token) {
	return {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
	};
}

const partLabelCacheTtlMs = Number(process.env.MAGENTO_PART_LABEL_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
let partLabelCache = {
	loadedAt: 0,
	lookup: new Map(),
	inFlightPromise: null,
};

function mapPartValueToLabel(rawValue, lookup) {
	if (rawValue === null || rawValue === undefined || rawValue === '') return rawValue;
	if (!(lookup instanceof Map) || lookup.size === 0) return rawValue;

	const tokens = String(rawValue)
		.split(',')
		.map((token) => token.trim())
		.filter(Boolean);

	if (!tokens.length) return rawValue;

	const mapped = tokens.map((token) => lookup.get(token) || token);
	return mapped.join(', ');
}

function mapProductPartLabel(product, lookup) {
	if (!product) return product;
	const mappedPart = mapPartValueToLabel(product.part, lookup);
	if (mappedPart === product.part) return product;
	return { ...product, part: mappedPart };
}

function mapProductsPartLabels(products, lookup) {
	if (!Array.isArray(products) || products.length === 0) return products;
	return products.map((product) => mapProductPartLabel(product, lookup));
}

async function getMagentoPartLabelLookup() {
	const now = Date.now();
	if (partLabelCache.lookup.size && now - partLabelCache.loadedAt < partLabelCacheTtlMs) {
		return partLabelCache.lookup;
	}

	if (partLabelCache.inFlightPromise) {
		return partLabelCache.inFlightPromise;
	}

	partLabelCache.inFlightPromise = (async () => {
		const token = process.env.MAGENTO_KEY;
		if (!token) {
			logger.warn('MAGENTO_KEY is not configured; part labels will remain raw option values');
			return new Map();
		}

		const endpoint = `${resolveMagentoBaseUrl()}/rest/V1/products/attributes/part`;
		const response = await axios.get(endpoint, buildMagentoRequestConfig(token));
		const options = Array.isArray(response?.data?.options) ? response.data.options : [];
		const lookup = new Map();

		for (const option of options) {
			const value = option?.value == null ? '' : String(option.value).trim();
			const label = option?.label == null ? '' : String(option.label).trim();
			if (!value || !label) continue;
			lookup.set(value, label);
		}

		partLabelCache = {
			loadedAt: Date.now(),
			lookup,
			inFlightPromise: null,
		};

		return lookup;
	})()
		.catch((error) => {
			logger.warn('Failed to refresh Magento part label lookup', { error: error.message });
			partLabelCache.inFlightPromise = null;
			return partLabelCache.lookup.size ? partLabelCache.lookup : new Map();
		});

	return partLabelCache.inFlightPromise;
}

async function fetchMagentoInvoicesByOrderId({ baseUrl, token, orderId }) {
	const endpoint = `${baseUrl}/rest/V1/invoices`;
	const params = {
		'searchCriteria[filterGroups][0][filters][0][field]': 'order_id',
		'searchCriteria[filterGroups][0][filters][0][value]': String(orderId),
		'searchCriteria[filterGroups][0][filters][0][condition_type]': 'eq',
		'searchCriteria[pageSize]': 20,
		'searchCriteria[currentPage]': 1,
	};

	const response = await axios.get(endpoint, {
		...buildMagentoRequestConfig(token),
		params,
	});

	const items = Array.isArray(response?.data?.items) ? response.data.items : [];
	return items.sort((a, b) => Number(b?.entity_id || 0) - Number(a?.entity_id || 0));
}

async function voidDeleteMagentoInvoiceByOrderId({ baseUrl, token, orderId }) {
	const endpoint = `${baseUrl}/rest/V1/jwa-order-cancel/orders/${encodeURIComponent(String(orderId))}/void-delete-invoice`;
	return axios.post(endpoint, {}, buildMagentoRequestConfig(token));
}

async function cancelMagentoOrder({ baseUrl, token, orderId }) {
	const endpoint = `${baseUrl}/rest/V1/orders/${encodeURIComponent(String(orderId))}/cancel`;
	return axios.post(endpoint, {}, buildMagentoRequestConfig(token));
}

async function fetchMagentoOrderById({ baseUrl, token, orderId }) {
	const endpoint = `${baseUrl}/rest/V1/orders/${encodeURIComponent(String(orderId))}`;
	const response = await axios.get(endpoint, buildMagentoRequestConfig(token));
	return response?.data || null;
}

async function createMagentoCancellationTicket({ baseUrl, token, orderId }) {
	const endpoint = `${baseUrl}/rest/V1/jwa-order-cancel/orders/${encodeURIComponent(String(orderId))}/ticket`;
	return axios.post(endpoint, {}, buildMagentoRequestConfig(token));
}

async function updateMagentoOrderCustomAttributes({ baseUrl, token, orderId, attributes }) {
	const endpoint = `${baseUrl}/rest/V1/jwa-order-cancel/orders/${encodeURIComponent(String(orderId))}/custom-attributes`;
	const normalizedAttributes = Array.isArray(attributes)
		? attributes
			.filter((entry) => entry && entry.attributeCode)
			.map((entry) => ({
				attributeCode: String(entry.attributeCode),
				value: entry.value == null ? '' : String(entry.value),
			}))
		: [];

	return axios.post(
		endpoint,
		{ attributes: normalizedAttributes },
		buildMagentoRequestConfig(token)
	);
}

app.get('/brands', async (req, res) => {
	try {
		const uniqueBrandNames = await prisma.product.findMany({
			distinct: ['brand_name'],
			select: {
				brand_name: true,
			},
		});

		res.json(uniqueBrandNames);
	} catch (error) {
		console.error(error);
		res.status(500).send('Internal server error');
	}
});

//* Routes for Orders *\\

// Route for getting all orders
// app.get('/api/orders', async (req, res) => {
//   try {
//     const orders = await prisma.order.findMany({
//       include: {
//         items: {
//           include: {
//             product: true,
//           },
//           where: {
//             base_price: {
//               gt: 0
//             },
// 		
//           },
//         },
//       },
//       orderBy: {
//         created_at: 'desc'
//       },
//     });
//     res.json(orders);
//   } catch (error) {
//     res.status(500).json({
//       error: `${error} Failed to fetch orders`
//     });
//   }
// });


// Route for getting orders with pagination and filters
app.get('/api/orders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 200); // Default 25, max 200 per page
    const skip = (page - 1) * limit;

    // Filter parameters
    const status = req.query.status || null;
	// Multi-keyword search and exclude support
	const search = req.query.search || '';
	const searchMode = req.query.searchMode || 'all';
	const exclude = req.query.exclude || '';
	const reportDate = req.query.date || '';
	const poStatus = req.query.poStatus || null; // 'not_set', 'not_set_4days', 'set', 'partial', 'pm_not_set', 'kd_not_set'
    const region = req.query.region || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const filterMode = req.query.filterMode || 'order'; // 'order' or 'items'
    const vendor = req.query.vendor || null; // vendor name for items filter
    const dateFilter = req.query.dateFilter || null; // 'today', 'yesterday', 'last7days'

    // Build where clause
    const where = {};

    // Status filter
    if (status) {
      where.status = status;
    }

    // Date filter (today, yesterday, last7days)
    // created_at is stored as "YYYY-MM-DD HH:MM:SS" in UTC
    // Filter by Toronto timezone (UTC-5 in winter, UTC-4 in summer)
    if (dateFilter) {
      // Get current date in Toronto
      const now = new Date();
      const torontoDateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);

      // Helper: convert Toronto date to UTC range (handles DST automatically)
      const getUTCRange = (torontoDate) => {
        // Create dates at start and end of day in Toronto
        const startLocal = new Date(`${torontoDate}T00:00:00Z`);
        const endLocal = new Date(`${torontoDate}T23:59:59Z`);

        // Get Toronto offset for these dates (handles DST)
        const getTorontoOffset = (date) => {
          const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
          const torontoDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
          return (utcDate - torontoDate) / 60000; // offset in minutes
        };

        const startOffset = getTorontoOffset(startLocal);
        const endOffset = getTorontoOffset(endLocal);

        const startUTC = new Date(startLocal.getTime() + startOffset * 60000);
        const endUTC = new Date(endLocal.getTime() + endOffset * 60000);

        const formatUTC = (d) => d.toISOString().replace('T', ' ').substring(0, 19);
        return { start: formatUTC(startUTC), end: formatUTC(endUTC) };
      };

      if (dateFilter === 'today') {
        const range = getUTCRange(torontoDateStr);
        where.created_at = { gte: range.start, lte: range.end };
      } else if (dateFilter === 'yesterday') {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Toronto',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(yesterday);
        const range = getUTCRange(yesterdayStr);
        where.created_at = { gte: range.start, lte: range.end };
      } else if (dateFilter === 'last7days') {
        const sevenDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
        const sevenDaysAgoStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Toronto',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(sevenDaysAgo);
        const range = getUTCRange(sevenDaysAgoStr);
        where.created_at = { gte: range.start };
      }
    }

    // Search and filter logic depends on filterMode
		if (filterMode === 'items') {
			// Items mode: search by SKU, product name, and filter by vendor
			const itemsFilter = {};

			// Multi-keyword AND search for SKU or product name
			if (search) {
				const keywords = search.split(' ').filter(Boolean);
				itemsFilter.AND = keywords.map((kw) => ({
					OR: [
						{ sku: { contains: kw, mode: 'insensitive' } },
						{ name: { contains: kw, mode: 'insensitive' } },
					],
				}));
			}
			// Exclude logic for items
			if (exclude) {
				const excludeWords = exclude.split(' ').filter(Boolean);
				itemsFilter.AND = [
					...(itemsFilter.AND || []),
					...excludeWords.map((kw) => ({
						AND: [
							{ sku: { not: { contains: kw, mode: 'insensitive' } } },
							{ name: { not: { contains: kw, mode: 'insensitive' } } },
						],
					})),
				];
			}
			// Filter by vendor (selected_supplier)
			if (vendor) {
				itemsFilter.selected_supplier = { equals: vendor, mode: 'insensitive' };
			}
			// Apply items filter if any conditions exist
			if (Object.keys(itemsFilter).length > 0) {
				where.items = { some: itemsFilter };
			}
		} else {
			// Order mode (default): multi-keyword search by order fields
			if (search) {
				const keywords = search.split(' ').filter(Boolean);
				if (searchMode === 'any') {
					const anyConditions = keywords.flatMap((kw) => [
						{ increment_id: { contains: kw, mode: 'insensitive' } },
						{ customer_firstname: { contains: kw, mode: 'insensitive' } },
						{ customer_lastname: { contains: kw, mode: 'insensitive' } },
						{ customer_email: { contains: kw, mode: 'insensitive' } },
						{ custom_po_number: { contains: kw, mode: 'insensitive' } },
						{ custom_order_note: { contains: kw, mode: 'insensitive' } },
					]);
					if (anyConditions.length > 0) {
						where.AND = [
							...(where.AND || []),
							{ OR: anyConditions },
						];
					}
				} else {
					where.AND = [
						...(where.AND || []),
						...keywords.map((kw) => ({
							OR: [
								{ increment_id: { contains: kw, mode: 'insensitive' } },
								{ customer_firstname: { contains: kw, mode: 'insensitive' } },
								{ customer_lastname: { contains: kw, mode: 'insensitive' } },
								{ customer_email: { contains: kw, mode: 'insensitive' } },
								{ custom_po_number: { contains: kw, mode: 'insensitive' } },
								{ custom_order_note: { contains: kw, mode: 'insensitive' } },
							],
						})),
					];
				}
			}
			// PurchaserReport: filter by date tokens in custom_po_number (order-independent)
			if (reportDate) {
				const dateTokens = reportDate
					.replace(/[-/\\_]/g, ' ')
					.split(/\s+/)
					.map((token) => token.trim())
					.filter(Boolean);
				if (dateTokens.length > 0) {
					where.AND = [
						...(where.AND || []),
						...dateTokens.map((token) => ({
							custom_po_number: { contains: token, mode: 'insensitive' },
						})),
					];
				}
			}
			// Exclude logic for order fields
			if (exclude) {
				const excludeWords = exclude.split(' ').filter(Boolean);
				where.AND = [
					...(where.AND || []),
					...excludeWords.map((kw) => ({
						AND: [
							{ increment_id: { not: { contains: kw, mode: 'insensitive' } } },
							{ customer_firstname: { not: { contains: kw, mode: 'insensitive' } } },
							{ customer_lastname: { not: { contains: kw, mode: 'insensitive' } } },
							{ customer_email: { not: { contains: kw, mode: 'insensitive' } } },
							{ custom_po_number: { not: { contains: kw, mode: 'insensitive' } } },
							{ custom_order_note: { not: { contains: kw, mode: 'insensitive' } } },
						],
					})),
				];
			}
		}

		const fourDaysAgoUtc = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace('T', ' ')
			.substring(0, 19);

		// PO Status filter (preserve existing AND conditions from date filter)
    if (poStatus === 'not_set') {
      where.OR = [
        { custom_po_number: null },
        { custom_po_number: '' },
        { custom_po_number: { equals: 'not set', mode: 'insensitive' } },
      ];
		} else if (poStatus === 'not_set_4days') {
			where.AND = [
				...(where.AND || []),
				{
					OR: [
						{ custom_po_number: null },
						{ custom_po_number: '' },
						{ custom_po_number: { equals: 'not set', mode: 'insensitive' } },
					],
				},
				{ created_at: { lte: fourDaysAgoUtc } },
			];
    } else if (poStatus === 'set') {
      where.AND = [
        ...(where.AND || []),
        { custom_po_number: { not: null } },
        { custom_po_number: { not: '' } },
        { NOT: { custom_po_number: { equals: 'not set', mode: 'insensitive' } } },
        { NOT: { custom_po_number: { contains: 'not set', mode: 'insensitive' } } },
      ];
    } else if (poStatus === 'partial') {
      where.AND = [
        ...(where.AND || []),
        { custom_po_number: { contains: 'not set', mode: 'insensitive' } },
        { NOT: { custom_po_number: { equals: 'not set', mode: 'insensitive' } } },
      ];
		} else if (poStatus === 'pm_not_set') {
			where.AND = [
				...(where.AND || []),
				{ custom_po_number: { contains: 'pm', mode: 'insensitive' } },
				{ custom_po_number: { contains: 'not set', mode: 'insensitive' } },
			];
		} else if (poStatus === 'kd_not_set') {
			where.AND = [
				...(where.AND || []),
				{ custom_po_number: { contains: 'kd', mode: 'insensitive' } },
				{ custom_po_number: { contains: 'not set', mode: 'insensitive' } },
			];
    }

    // Region filter
    if (region) {
      where.region = region;
    }

    // Date range filter
    if (dateFrom || dateTo) {
      where.created_at = {};
      if (dateFrom) {
        where.created_at.gte = new Date(dateFrom);
      }
      if (dateTo) {
        where.created_at.lte = new Date(dateTo);
      }
    }

		const [orders, total] = await Promise.all([
			prisma.order.findMany({
				where,
				skip,
				take: limit,
				   select: {
					   entity_id: true,
					   id: true,
					   created_at: true,
					   updated_at: true,
					   customer_email: true,
					   coupon_code: true,
					   customer_firstname: true,
					   customer_lastname: true,
					   grand_total: true,
					   subtotal: true,
					   tax_amount: true,
					   order_bis: true,
					   increment_id: true,
					   order_currency_code: true,
					   total_qty_ordered: true,
					   status: true,
					   base_total_due: true,
					   shipping_amount: true,
					   shipping_cost_jj: true,
					   freight_shipping: true,
					   shipping_description: true,
					   custom_po_number: true,
					   sales_rep: true,
					   weltpixel_fraud_score: true,
					   email_first_seen: true,
					   city: true,
					   region: true,
					   method_title: true,
					   shipping_city: true,
					   shipping_country_id: true,
					   shipping_firstname: true,
					   shipping_lastname: true,
					   shipping_postcode: true,
					   shipping_region: true,
					   shipping_street1: true,
					   shipping_street2: true,
					   shipping_street3: true,
					   shipping_telephone: true,
					   shipping_company: true,
					   billing_city: true,
					   billing_country_id: true,
					   billing_postcode: true,
					   billing_region: true,
					   billing_street: true,
					   custom_ship_status: true,
					   custom_order_note: true,
					   items: {
						   include: {
							   product: {
								   select: {
									   sku: true,
									   name: true,
									   price: true,
									   brand_name: true,
									   image: true,
									   weight: true,
									   shippingFreight: true,
									   url_path: true,
									   black_friday_sale: true,
									vendorProducts: {
										select: {
											id: true,
											vendor_cost: true,
											vendor_cost_usd: true,
											quadratec_shipping_surcharge_usd: true,
											vendor_inventory: true,
											vendor_inventory_string: true,
											vendor_id: true,
											vendor: {
												select: {
													id: true,
													name: true,
												},
											},
										},
									},
								   },
							   },
						   },
						   where: {
							   base_price: {
								   gt: 0,
							   },
						   },
						   orderBy: {
							   id: 'asc',
						   },
					   },
				   },
				orderBy: {
					created_at: 'desc',
				},
			}),
			prisma.order.count({ where }),
		]);
		// Debug: print the first order to check for custom_ship_status and custom_order_note
		if (orders && orders.length) {
			console.log('First order from DB:', orders[0]);
		} else {
			console.log('No orders returned from DB');
		}

		res.json({
			data: orders,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
			filters: {
				status,
				search,
				poStatus,
				region,
				dateFrom,
				dateTo,
				filterMode,
				vendor,
				dateFilter,
			},
		});
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      error: `${error} Failed to fetch orders`,
    });
  }
});

// Route for getting order metrics (independent of pagination)
app.get('/api/orders/metrics', async (req, res) => {
  try {
    // Get current date in Toronto timezone
    // created_at is stored as "YYYY-MM-DD HH:MM:SS" in UTC
    // Filter by Toronto timezone (UTC-5 in winter, UTC-4 in summer)
    const now = new Date();
    const torontoFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Helper: convert Toronto date to UTC range (handles DST automatically)
    const getUTCRange = (torontoDate) => {
      // Create dates at start and end of day in Toronto
      const startLocal = new Date(`${torontoDate}T00:00:00Z`);
      const endLocal = new Date(`${torontoDate}T23:59:59Z`);

      // Get Toronto offset for these dates (handles DST)
      const getTorontoOffset = (date) => {
        const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
        const torontoDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
        return (utcDate - torontoDate) / 60000; // offset in minutes
      };

      const startOffset = getTorontoOffset(startLocal);
      const endOffset = getTorontoOffset(endLocal);

      const startUTC = new Date(startLocal.getTime() + startOffset * 60000);
      const endUTC = new Date(endLocal.getTime() + endOffset * 60000);

      const formatUTC = (d) => d.toISOString().replace('T', ' ').substring(0, 19);
      return { start: formatUTC(startUTC), end: formatUTC(endUTC) };
    };

    // Get today's date in Toronto
    const todayStr = torontoFormatter.format(now);
    const todayRange = getUTCRange(todayStr);

    // Calculate yesterday and 7 days ago in Toronto
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = torontoFormatter.format(yesterday);
    const yesterdayRange = getUTCRange(yesterdayStr);

    const sevenDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = torontoFormatter.format(sevenDaysAgo);
    const sevenDaysAgoRange = getUTCRange(sevenDaysAgoStr);
		const fourDaysAgoUtc = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace('T', ' ')
			.substring(0, 19);

    // Run all counts in parallel for performance
    const [
      notSetCount,
			staleNotSetCount,
      todayCount,
      yesterdayCount,
      last7DaysCount,
      pmNotSetCount,
			kdNotSetCount,
      gwCount,
      totalCount
    ] = await Promise.all([
      // Not Set Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE custom_po_number IS NULL
        OR custom_po_number = ''
        OR LOWER(custom_po_number) = 'not set'
      `.then(result => Number(result[0]?.count || 0)),

			// Not Set Orders older than 4 days
			prisma.$queryRaw`
				SELECT COUNT(*) as count FROM "Order"
				WHERE (
					custom_po_number IS NULL
					OR custom_po_number = ''
					OR LOWER(custom_po_number) = 'not set'
				)
				AND created_at <= ${fourDaysAgoUtc}
			`.then(result => Number(result[0]?.count || 0)),

      // Today's Orders (Toronto timezone)
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE created_at >= ${todayRange.start} AND created_at <= ${todayRange.end}
      `.then(result => Number(result[0]?.count || 0)),

      // Yesterday's Orders (Toronto timezone)
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE created_at >= ${yesterdayRange.start} AND created_at <= ${yesterdayRange.end}
      `.then(result => Number(result[0]?.count || 0)),

      // Last 7 Days Orders (Toronto timezone)
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE created_at >= ${sevenDaysAgoRange.start}
      `.then(result => Number(result[0]?.count || 0)),

      // PM Not Set Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE LOWER(custom_po_number) LIKE '%pm%'
        AND LOWER(custom_po_number) LIKE '%not set%'
      `.then(result => Number(result[0]?.count || 0)),

			// KD Not Set Orders
			prisma.$queryRaw`
				SELECT COUNT(*) as count FROM "Order"
				WHERE LOWER(custom_po_number) LIKE '%kd%'
				AND LOWER(custom_po_number) LIKE '%not set%'
			`.then(result => Number(result[0]?.count || 0)),

      // GW Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE LOWER(custom_po_number) LIKE '%gw%'
      `.then(result => Number(result[0]?.count || 0)),

      // Total Orders
      prisma.order.count(),
    ]);

    res.json({
      notSetCount,
			staleNotSetCount,
      todayCount,
      yesterdayCount,
      last7DaysCount,
      pmNotSetCount,
			kdNotSetCount,
      gwCount,
      totalCount,
    });
  } catch (error) {
    console.error('Error fetching order metrics:', error);
    res.status(500).json({ error: 'Failed to fetch order metrics', details: error.message });
  }
});

app.get('/api/seed-orders', async (req, res) => {
	const limit = Number(req.query.limit) || Number(process.env.SEED_ORDER_LIMIT) || 200;

	res.status(202).json({
		status: 'started',
		limit,
	});

	seedOrders(limit).catch((error) => {
		console.error("Error seeding data:", error);
	});
});

app.get('/api/seed-orders-all', async (req, res) => {
	res.status(202).json({
		status: 'started',
	});

	seedOrdersAll().catch((error) => {
		console.error("Error seeding all orders:", error);
	});
});

const seedJobs = new Map();

const createSeedJob = (limit) => {
	const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	seedJobs.set(jobId, {
		id: jobId,
		limit,
		status: 'running',
		processed: 0,
		total: null,
		error: null,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		finishedAt: null,
	});
	setTimeout(() => seedJobs.delete(jobId), 60 * 60 * 1000);
	return jobId;
};

const updateSeedJob = (jobId, patch) => {
	const job = seedJobs.get(jobId);
	if (!job) return;
	seedJobs.set(jobId, {
		...job,
		...patch,
		updatedAt: Date.now(),
	});
};

// seed-orders-all deletes every order before reseeding, so concurrent seed
// jobs (e.g. two browser tabs) would corrupt data
const hasRunningSeedJob = () =>
	[...seedJobs.values()].some((job) => job.status === 'running');

app.post('/api/seed-orders/start', async (req, res) => {
	if (hasRunningSeedJob()) {
		return res.status(409).json({ error: 'A seed job is already running' });
	}
	const limit = Number(req.body?.limit) || 4000;
	const jobId = createSeedJob(limit);

	res.status(202).json({
		jobId,
		limit,
	});

	seedOrders(limit, {
		onProgress: ({ total, processed, status, error }) => {
			updateSeedJob(jobId, {
				total,
				processed,
				status: status || 'running',
				error: error || null,
				finishedAt: status === 'done' || status === 'error' ? Date.now() : null,
			});
		},
	}).catch((error) => {
		console.error("Error seeding data:", error);
		updateSeedJob(jobId, {
			status: 'error',
			error: error?.message || 'Seed failed',
			finishedAt: Date.now(),
		});
	});
});

app.post('/api/seed-orders-all/start', async (req, res) => {
	if (hasRunningSeedJob()) {
		return res.status(409).json({ error: 'A seed job is already running' });
	}
	const jobId = createSeedJob(null);

	res.status(202).json({
		jobId,
	});

	seedOrdersAll({
		onProgress: ({ total, processed, status, error }) => {
			updateSeedJob(jobId, {
				total: total ?? null,
				processed,
				status: status || 'running',
				error: error || null,
				finishedAt: status === 'done' || status === 'error' ? Date.now() : null,
			});
		},
	}).catch((error) => {
		console.error("Error seeding all orders:", error);
		updateSeedJob(jobId, {
			status: 'error',
			error: error?.message || 'Seed failed',
			finishedAt: Date.now(),
		});
	});
});

// Sync incremental: busca so os pedidos com updated_at >= watermark e faz
// upsert. E o caminho padrao do botao "Update Orders" e do cron delta.
app.post('/api/seed-orders-delta/start', async (req, res) => {
	if (hasRunningSeedJob()) {
		return res.status(409).json({ error: 'A seed job is already running' });
	}
	const jobId = createSeedJob(null);

	res.status(202).json({
		jobId,
	});

	seedOrdersDelta({
		onProgress: ({ total, processed, status, error }) => {
			updateSeedJob(jobId, {
				total: total ?? null,
				processed,
				status: status || 'running',
				error: error || null,
				finishedAt: status === 'done' || status === 'error' ? Date.now() : null,
			});
		},
	}).catch((error) => {
		console.error("Error running orders delta sync:", error);
		updateSeedJob(jobId, {
			status: 'error',
			error: error?.message || 'Delta sync failed',
			finishedAt: Date.now(),
		});
	});
});

app.get('/api/orders/sync-state', async (req, res) => {
	try {
		const state = await prisma.syncState.findUnique({
			where: { key: 'orders-delta-watermark' },
		});
		res.json({
			watermark: state?.value || null,
			lastSyncedAt: state?.updatedAt || null,
		});
	} catch (error) {
		console.error('Failed to fetch orders sync state:', error);
		res.status(500).json({ error: 'Failed to fetch sync state' });
	}
});

app.get('/api/seed-orders/status/:jobId', (req, res) => {
	const job = seedJobs.get(req.params.jobId);
	if (!job) {
		return res.status(404).json({ error: 'Seed job not found' });
	}
	return res.json(job);
});

//Route for getting a single order
app.get('/api/orders/:id', async (req, res) => {
	try {
		const order = await prisma.order.findUnique({
			where: {
				entity_id: Number(req.params.id),
			},
		});
		res.json(order);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch order' });
	}
});

app.post('/api/orders/:id/cancel-workflow', async (req, res) => {
	const manualActionsStillRequired = [];
	const addManualAction = (action) => {
		if (!manualActionsStillRequired.includes(action)) {
			manualActionsStillRequired.push(action);
		}
	};

	const completedActions = [];
	const failedActions = [];
	const informationalActions = [];

	try {
		if (process.env.ENABLE_AUTH !== 'true') {
			return res.status(403).json({
				error: 'Feature locked',
				message: 'Order cancellation workflow requires authentication to be enabled',
			});
		}

		const requesterUsername = (req.user?.username || '').toLowerCase();
		if (!ORDER_CANCEL_EXECUTE_ALLOWED_USERS.has(requesterUsername)) {
			return res.status(403).json({
				error: 'Forbidden',
				message: 'You are not authorized to use order cancellation workflow',
			});
		}

		const dryRun = req.body?.dryRun === true || String(req.query?.dryRun || '').toLowerCase() === 'true';
		const cancellationPoNumber = buildCancellationPoNumber(requesterUsername);
		if (dryRun && !ORDER_CANCEL_DRY_RUN_ALLOWED_USERS.has(requesterUsername)) {
			return res.status(403).json({
				error: 'Forbidden',
				message: 'You are not authorized to use dry run for order cancellation workflow',
			});
		}

		const routeOrderIdentifier = String(req.params.id || '').trim();
		if (!routeOrderIdentifier) {
			return res.status(400).json({ error: 'Invalid order identifier' });
		}

		const numericOrderIdentifier = Number(routeOrderIdentifier);
		const isNumericIdentifier = Number.isFinite(numericOrderIdentifier) && numericOrderIdentifier > 0;
		const orderSelect = {
			entity_id: true,
			increment_id: true,
			status: true,
			grand_total: true,
			total_qty_ordered: true,
			custom_po_number: true,
			custom_ship_status: true,
			custom_order_note: true,
			shipping_cost_jj: true,
			customer_firstname: true,
			customer_lastname: true,
			customer_email: true,
			region: true,
			method_title: true,
		};

		let order = null;
		if (isNumericIdentifier) {
			order = await prisma.order.findUnique({
				where: { entity_id: numericOrderIdentifier },
				select: orderSelect,
			});
		}

		if (!order) {
			order = await prisma.order.findFirst({
				where: { increment_id: routeOrderIdentifier },
				select: orderSelect,
			});
		}

		if (!order) {
			return res.status(404).json({ error: `Order ${routeOrderIdentifier} not found` });
		}

		const manualRefundPaymentLabel = getManualRefundRoutingPaymentLabel(order);
		if (ORDER_CANCEL_MANUAL_REFUND_RESTRICTED_USERS.has(requesterUsername) && manualRefundPaymentLabel) {
			return res.status(403).json({
				error: 'Manual refund required',
				message: `${manualRefundPaymentLabel} refunds must be processed manually by Jacob. Send this order to Jacob instead of cancelling it from the Pricing Tool.`,
				paymentMethod: manualRefundPaymentLabel,
			});
		}

		const magentoOrderEntityId = Number(order.entity_id);
		if (!Number.isFinite(magentoOrderEntityId) || magentoOrderEntityId <= 0) {
			return res.status(500).json({ error: 'Resolved order is missing a valid Magento entity id' });
		}

		const token = process.env.MAGENTO_KEY;
		if (!token) {
			return res.status(500).json({ error: 'MAGENTO_KEY is not configured' });
		}

		const magentoBaseUrl = resolveMagentoBaseUrl();
		let selectedInvoiceId = null;
		let selectedInvoiceIncrementId = null;
		let invoiceVoidDeleteCompleted = false;
		let orderCancelledInMagento = false;
		let cancellationTicketSent = false;
		let cancellationAttributesUpdated = false;
		let localStatusUpdated = false;
		let localStatusUpdateError = null;

		if (cancellationPoNumber.usedFallback) {
			informationalActions.push(
				`No initials mapping configured for ${requesterUsername || 'unknown user'}; used fallback initials ${cancellationPoNumber.initials}`
			);
		}

		try {
			const invoices = await fetchMagentoInvoicesByOrderId({
				baseUrl: magentoBaseUrl,
				token,
				orderId: magentoOrderEntityId,
			});

			if (!invoices.length) {
				informationalActions.push('No existing invoice found before void-delete attempt');
			} else {
				selectedInvoiceId = invoices[0]?.entity_id;
				selectedInvoiceIncrementId = invoices[0]?.increment_id || null;
			}
		} catch (invoiceLookupError) {
			informationalActions.push(
				`Unable to pre-fetch invoice metadata before void-delete attempt: ${invoiceLookupError?.response?.data?.message || invoiceLookupError?.response?.data || invoiceLookupError.message}`
			);
		}

		try {
			if (dryRun) {
				completedActions.push('Dry run: invoice would be voided/deleted via order-level endpoint');
			} else {
				await voidDeleteMagentoInvoiceByOrderId({
					baseUrl: magentoBaseUrl,
					token,
					orderId: magentoOrderEntityId,
				});
				invoiceVoidDeleteCompleted = true;
				completedActions.push(
					selectedInvoiceIncrementId
						? `Invoice #${selectedInvoiceIncrementId} voided/deleted`
						: 'Invoice void/delete request completed'
				);
			}
		} catch (voidDeleteError) {
			failedActions.push({
				action: 'Void and delete invoice',
				message: voidDeleteError?.response?.data?.message || voidDeleteError?.response?.data || voidDeleteError.message,
				statusCode: voidDeleteError?.response?.status || null,
				invoiceId: selectedInvoiceId,
			});
			addManualAction('Void and delete invoice');
		}

		try {
			if (dryRun) {
				completedActions.push('Dry run: order would be cancelled');
			} else {
				await cancelMagentoOrder({
					baseUrl: magentoBaseUrl,
					token,
					orderId: magentoOrderEntityId,
				});

				const magentoOrderAfterCancel = await fetchMagentoOrderById({
					baseUrl: magentoBaseUrl,
					token,
					orderId: magentoOrderEntityId,
				});
				const magentoStatusAfterCancel = String(magentoOrderAfterCancel?.status || '').toLowerCase();
				const isMagentoCanceled = magentoStatusAfterCancel.includes('cancel');

				if (isMagentoCanceled) {
					orderCancelledInMagento = true;
					completedActions.push('Order cancelled');
				} else {
					failedActions.push({
						action: 'Cancel order',
						message: `Magento cancel endpoint returned but order status remains ${magentoOrderAfterCancel?.status || 'unknown'}`,
						statusCode: null,
					});
				}
			}
		} catch (cancelError) {
			failedActions.push({
				action: 'Cancel order',
				message: cancelError?.response?.data?.message || cancelError?.response?.data || cancelError.message,
				statusCode: cancelError?.response?.status || null,
			});
		}

		try {
			if (dryRun) {
				completedActions.push('Dry run: cancellation ticket would be created and sent');
			} else {
				await createMagentoCancellationTicket({
					baseUrl: magentoBaseUrl,
					token,
					orderId: magentoOrderEntityId,
				});
				cancellationTicketSent = true;
				completedActions.push('Cancellation ticket created and sent');
			}
		} catch (ticketError) {
			failedActions.push({
				action: 'Create and send cancellation ticket',
				message:
					ticketError?.response?.data?.message ||
					ticketError?.response?.data ||
					ticketError.message,
				statusCode: ticketError?.response?.status || null,
			});
			addManualAction('Create and send cancellation ticket');
		}

		try {
			if (dryRun) {
				completedActions.push(
					`Dry run: order attributes would be updated (custom_po_number=${cancellationPoNumber.value}, custom_ship_status=2480)`
				);
			} else if (orderCancelledInMagento) {
				await updateMagentoOrderCustomAttributes({
					baseUrl: magentoBaseUrl,
					token,
					orderId: magentoOrderEntityId,
					attributes: [
						{
							attributeCode: 'custom_po_number',
							value: cancellationPoNumber.value,
						},
						{
							attributeCode: 'custom_ship_status',
							value: '2480',
						},
					],
				});
				cancellationAttributesUpdated = true;
				completedActions.push(
					`Cancellation custom attributes updated (custom_po_number=${cancellationPoNumber.value}, custom_ship_status=2480)`
				);
			} else {
				informationalActions.push('Skipped custom attribute update because order is not confirmed canceled in Magento');
				addManualAction('Update cancellation custom attributes (PO and ship status)');
			}
		} catch (attributeUpdateError) {
			failedActions.push({
				action: 'Update cancellation custom attributes',
				message:
					attributeUpdateError?.response?.data?.message ||
					attributeUpdateError?.response?.data ||
					attributeUpdateError.message,
				statusCode: attributeUpdateError?.response?.status || null,
			});
			addManualAction('Update cancellation custom attributes (PO and ship status)');
		}

		if (!dryRun && (invoiceVoidDeleteCompleted || orderCancelledInMagento || cancellationTicketSent)) {
			try {
				await prisma.order.update({
					where: { entity_id: magentoOrderEntityId },
					data: { status: 'canceled' },
				});
				localStatusUpdated = true;
				if (!orderCancelledInMagento && cancellationTicketSent) {
					informationalActions.push(
						'Magento cancel did not complete, but local status was marked canceled because the cancellation ticket was sent'
					);
				}
			} catch (dbUpdateError) {
				localStatusUpdateError = dbUpdateError.message;
				failedActions.push({
					action: 'Update local order status',
					message: dbUpdateError.message,
					statusCode: null,
				});
				logger.warn('Failed to update local order status after cancellation workflow', {
					orderId: magentoOrderEntityId,
					error: dbUpdateError.message,
					orderCancelledInMagento,
					cancellationTicketSent,
				});
			}
		}

		const cancellationRecordedAt = new Date();
		const cancellationSucceeded = !dryRun && (orderCancelledInMagento || localStatusUpdated);
		if (!dryRun) {
			const cancelWorkflowHistoryEntry = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				recordedAt: cancellationRecordedAt,
				reportDate: getDateStringInTimezone(cancellationRecordedAt, cancellationReportTimezone || 'America/Toronto'),
				timeZone: cancellationReportTimezone || 'America/Toronto',
				cancelledAt: cancellationSucceeded ? cancellationRecordedAt : null,
				cancelledBy: requesterUsername || 'unknown',
				dryRun,
				outcome: cancellationSucceeded ? 'cancelled' : 'not_cancelled',
				orderId: magentoOrderEntityId,
				incrementId: order.increment_id,
				requestedOrderIdentifier: routeOrderIdentifier,
				orderCancelledInMagento,
				invoiceVoidDeleteCompleted,
				cancellationTicketSent,
				cancellationAttributesUpdated,
				localStatusUpdated,
				failedActions,
				completedActions,
				manualActionsStillRequired,
				orderSnapshot: {
					...order,
					status: localStatusUpdated ? 'canceled' : order.status,
					custom_po_number: cancellationAttributesUpdated ? cancellationPoNumber.value : order.custom_po_number,
					custom_ship_status: cancellationAttributesUpdated ? '2480' : order.custom_ship_status,
				},
			};

			try {
				await prisma.orderCancellationWorkflowHistory.createMany({
					data: [mapCancelWorkflowHistoryEntryToDbRow(cancelWorkflowHistoryEntry)],
					skipDuplicates: true,
				});
			} catch (historyError) {
				logger.error('Failed to record order cancellation workflow history in database', {
					orderId: magentoOrderEntityId,
					incrementId: order.increment_id,
					error: historyError.message,
				});
			}

			appendCancelWorkflowHistoryEntry({
				...cancelWorkflowHistoryEntry,
				recordedAt: cancellationRecordedAt.toISOString(),
				cancelledAt: cancellationSucceeded ? cancellationRecordedAt.toISOString() : null,
			});
		}

		return res.json({
			success: failedActions.length === 0 && completedActions.length > 0,
			dryRun,
			orderId: magentoOrderEntityId,
			requestedOrderIdentifier: routeOrderIdentifier,
			incrementId: order.increment_id,
			invoice: selectedInvoiceId
				? {
					entityId: selectedInvoiceId,
					incrementId: selectedInvoiceIncrementId,
				}
				: null,
			completedActions,
			failedActions,
			informationalActions,
			cancellationAttributesUpdated,
			cancellationAttributes: {
				custom_po_number: cancellationPoNumber.value,
				custom_ship_status: '2480',
			},
			localStatusUpdated,
			localStatusUpdateError,
			manualActionsStillRequired,
		});
	} catch (error) {
		logger.error('Failed to execute order cancel workflow', {
			orderId: req.params?.id,
			error: error.message,
		});
		return res.status(500).json({ error: 'Failed to execute cancel workflow' });
	}
});

app.post('/api/orders/:id/initialize-po-number', async (req, res) => {
	try {
		if (process.env.ENABLE_AUTH !== 'true') {
			return res.status(403).json({
				error: 'Feature locked',
				message: 'PO initializer requires authentication to be enabled',
			});
		}

		const requesterUsername = (req.user?.username || '').toLowerCase();
		if (!ORDER_PO_INIT_ALLOWED_USERS.has(requesterUsername)) {
			return res.status(403).json({
				error: 'Forbidden',
				message: 'You are not authorized to initialize PO numbers',
			});
		}

		const routeOrderIdentifier = String(req.params.id || '').trim();
		if (!routeOrderIdentifier) {
			return res.status(400).json({ error: 'Invalid order identifier' });
		}

		const numericOrderIdentifier = Number(routeOrderIdentifier);
		const isNumericIdentifier = Number.isFinite(numericOrderIdentifier) && numericOrderIdentifier > 0;

		let order = null;
		if (isNumericIdentifier) {
			order = await prisma.order.findUnique({
				where: { entity_id: numericOrderIdentifier },
				select: {
					entity_id: true,
					increment_id: true,
					custom_po_number: true,
				},
			});
		}

		if (!order) {
			order = await prisma.order.findFirst({
				where: { increment_id: routeOrderIdentifier },
				select: {
					entity_id: true,
					increment_id: true,
					custom_po_number: true,
				},
			});
		}

		if (!order) {
			return res.status(404).json({ error: `Order ${routeOrderIdentifier} not found` });
		}

		const orderId = Number(order.entity_id);
		if (!Number.isFinite(orderId) || orderId <= 0) {
			return res.status(500).json({ error: 'Resolved order is missing a valid Magento entity id' });
		}

		const token = process.env.MAGENTO_KEY;
		if (!token) {
			return res.status(500).json({ error: 'MAGENTO_KEY is not configured' });
		}

		const { initials, usedFallback } = resolveUserInitials(requesterUsername);
		const dateLabel = new Date().toLocaleDateString('en-CA', {
			timeZone: cancellationReportTimezone || 'America/Toronto',
			month: 'short',
			day: 'numeric',
		});
		const customPoNumber = `Not Set - Initialized ${initials} ${dateLabel}`;

		await updateMagentoOrderCustomAttributes({
			baseUrl: resolveMagentoBaseUrl(),
			token,
			orderId,
			attributes: [
				{
					attributeCode: 'custom_po_number',
					value: customPoNumber,
				},
			],
		});

		await prisma.order.update({
			where: { entity_id: orderId },
			data: {
				custom_po_number: customPoNumber,
			},
		});

		return res.json({
			success: true,
			orderId,
			incrementId: order.increment_id,
			customPoNumber,
			initials,
			dateLabel,
			usedFallbackInitials: usedFallback,
		});
	} catch (error) {
		logger.error('Failed to initialize custom PO number', {
			orderId: req.params?.id,
			error: error.message,
		});
		return res.status(500).json({ error: 'Failed to initialize custom PO number' });
	}
});

// Route for updating an order status
app.post('/api/orders/:id/edit', async (req, res) => {
	try {
		console.log(req.body);
		const order = await prisma.order.update({
			where: {
				entity_id: Number(req.params.id),
			},
			data: {
				// status: req.body.status,
				customer_email: req.body.customer_email,
				// coupon_code: req.body.coupon_code,
				customer_firstname: req.body.customer_firstname,
				customer_lastname: req.body.customer_lastname,
				grand_total: parseFloat(req.body.grand_total),
				base_total_due: parseFloat(req.body.base_total_due),
				// increment_id: req.body.increment_id,
				// order_currency_code: req.body.order_currency_code,
				total_qty_ordered: parseFloat(req.body.total_qty_ordered),
				shipping_firstname,
        shipping_lastname,
        shipping_postcode,
        shipping_street1,
        shipping_street2,
        shipping_street3,
        shipping_telephone,
        shipping_city,
        shipping_region,
        shipping_country_id,
				shipping_company
			},
		});
		console.log(order);
		res.json(order);
	} catch (error) {
		res.status(500).json({ error: 'Failed to update order' });
	}
});

//Route for deleting an order
app.post('/api/orders/:id/delete', async (req, res) => {
	try {
		const order = await prisma.order.delete({
			where: {
				entity_id: Number(req.params.id),
			},
		});
		res.json(order);
	} catch (error) {
		res.status(500).json({ error: 'Failed to delete order' });
	}
});

//* Routes for Product Orders *\\

//Route for getting all product orders
app.get('/api/order_products', async (req, res) => {
	try {
		const productOrders = await prisma.orderProduct.findMany({
			include: {
				order: true,
				product: true,
			},
		});
		res.json(productOrders);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch product orders' });
	}
});

// Route for creating an order product
app.post('/order_products', async (req, res) => {
	try {
		const {
			order_id,
			name,
			sku,
			base_price,
			base_price_incl_tax,
			discount_amount,
			discount_invoiced,
			discount_percent,
			original_price,
			price,
			price_incl_tax,
			product_id,
			qty_ordered,
		} = req.body;
		const createdOrderProduct = await prisma.orderProduct.create({
			data: {
				order_id: order_id,
				name: name,
				sku: sku,
				base_price: base_price,
				base_price_incl_tax: base_price_incl_tax,
				discount_amount: discount_amount,
				discount_invoiced: discount_invoiced,
				discount_percent: discount_percent,
				original_price: original_price,
				price: price,
				price_incl_tax: price_incl_tax,
				product_id: product_id,
				qty_ordered: qty_ordered,
			},
		});
		res.json(createdOrderProduct);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to create order product' });
	}
});

// Route for editing an order product
app.post('/order_products/:id/edit', async (req, res) => {
	try {
		const id = req.params.id;
		const {
			name,
			sku,
			base_price,
			base_price_incl_tax,
			discount_amount,
			discount_invoiced,
			discount_percent,
			original_price,
			price,
			price_incl_tax,
			product_id,
			qty_ordered,
			selected_supplier,
			selected_supplier_cost,
		} = req.body;
		const updatedOrderProduct = await prisma.orderProduct.update({
			where: {
				id: Number(id),
			},
			data: {
				name: name,
				sku: sku,
				base_price: base_price,
				base_price_incl_tax: base_price_incl_tax,
				discount_amount: discount_amount,
				discount_invoiced: discount_invoiced,
				discount_percent: discount_percent,
				original_price: original_price,
				price: parseFloat(price),
				price_incl_tax: price_incl_tax,
				product_id: product_id,
				qty_ordered: parseFloat(qty_ordered),
				selected_supplier: selected_supplier,
				selected_supplier_cost: selected_supplier_cost,
			},
		});
		res.json(updatedOrderProduct);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to update order product' });
	}
});

// Route for editing an order product
app.post('/order_products/:id/edit/selected_supplier', async (req, res) => {
	try {
		const id = req.params.id;
		const {
			name,
			sku,
			base_price,
			base_price_incl_tax,
			discount_amount,
			discount_invoiced,
			discount_percent,
			original_price,
			price,
			price_incl_tax,
			product_id,
			qty_ordered,
			selected_supplier,
			selected_supplier_cost,
		} = req.body;
		const updatedOrderProduct = await prisma.orderProduct.update({
			where: {
				id: Number(id),
			},
			data: {
				name: name,
				sku: sku,
				base_price: base_price,
				base_price_incl_tax: base_price_incl_tax,
				discount_amount: discount_amount,
				discount_invoiced: discount_invoiced,
				discount_percent: discount_percent,
				original_price: original_price,
				price: price,
				price_incl_tax: price_incl_tax,
				product_id: product_id,
				qty_ordered: qty_ordered,
				selected_supplier: selected_supplier,
				selected_supplier_cost: selected_supplier_cost,
			},
		});
		res.json(updatedOrderProduct);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to update order product' });
	}
});

// Route for deleting an order product
app.delete('/order_products/:id/delete', async (req, res) => {
	try {
		const id = parseInt(req.params.id);

		// Delete the order product from the database using Prisma
		await prisma.orderProduct.delete({
			where: { id },
		});

		// res.redirect(204, '/orders');
		const orders = await prisma.order.findMany({
			include: {
				items: true,
			},
		});
		res.json(orders);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to delete order product' });
	}
});

//* Routes for Vendor Products *\\

// Route for getting all vendor products
app.get('/api/vendor_products', async (req, res) => {
	try {
		// vendor products including order products and vendor
		const vendorProducts = await prisma.vendorProduct.findMany({
			include: {
				vendor: true,
				product: true,
			},
		});
		// Extracting only the necessary fields from the query result
		const vendorProductsResult = vendorProducts.map(
			({ product_sku, vendor_cost }) => ({
				product_sku,
				vendor_cost,
			})
		);

		res.json(vendorProductsResult);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to vendor products' });
	}
});

// Route for getting vendor products by sku
app.get('/api/vendor_products/:sku', async (req, res) => {
	console.log(req.params.sku);
	try {
		const vendorProduct = await prisma.vendorProduct.findMany({
			where: {
				product_sku: req.params.sku,
			},
			include: {
				vendor: true,
				product: true,
			},
		});
		res.json(vendorProduct);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch vendor product' });
	}
});

// Route for getting Vendors info
app.get('/api/vendors', async (req, res) => {
	try {
		const vendors = await prisma.vendor.findMany();
		res.json(vendors);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch vendors' });
	}
});

//get all vendornproducts by vendor id
app.get('/api/vendor_products/vendor/:id', async (req, res) => {
	try {
		const vendorProducts = await prisma.vendorProduct.findMany({
			where: {
				vendor_id: parseInt(req.params.id),
			},
		});
		res.json(vendorProducts);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch vendor products' });
	}
});

//* Routes for Purchase Orders *\\

// Route for getting all Purchase Orders
// app.get("/api/purchase_orders", async (req, res) => {
//   try {
//     const purchaseOrders = await prisma.purchaseOrder.findMany({
//       include: {
//         vendor: true,
//         user: true,
//         order: {
//           include: {
//             items: true,
//           },
//         },
//         purchaseOrderLineItems: {
//           include: {
//             vendorProduct: true,
//             purchaseOrder: true,
//           },
//         },
//       },
//     });
//     res.json(purchaseOrders);
//   } catch (error) {
//     console.log(error);
//     res.status(500).json({ error: "Failed to fetch purchase orders" });
//   }
// });

app.get('/api/purchase_orders', async (req, res) => {
	try {
		const purchaseOrders = await prisma.purchaseOrder.findMany({
			include: {
				purchaseOrderLineItems: true,
			},
		});
		res.json(purchaseOrders);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch purchase orders' });
	}
});

// Route for getting latest Purchase Orders by vendor
app.get('/api/purchase_orders/vendor/:id', async (req, res) => {
	try {
		const purchaseOrders = await prisma.purchaseOrder.findMany({
			where: {
				vendor_id: Number(req.params.id),
			},
			include: {
				vendor: true,
				user: true,
				order: {
					include: {
						items: true,
					},
				},
				purchaseOrderLineItems: {
					include: {
						purchaseOrder: true,
					},
				},
			},
			orderBy: {
				created_at: 'desc',
			},
			take: 10, // Limit the results to 10 latest Purchase Orders
		});
		res.json(purchaseOrders);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch purchase orders' });
	}
});


// Route for getting a single Purchase Order
app.get('/api/purchase_orders/:id', async (req, res) => {
	const purchaseOrder = await prisma.purchaseOrder.findUnique({
		where: {
			id: Number(req.params.id),
		},
		include: {
			vendor: true,
			user: true,
			order: true,
			purchaseOrderLineItems: {
				include: {
					vendorProduct: true,
					purchaseOrder: true,
				},
			},
		},
	});
	res.json(purchaseOrder);
});

// Route for creating a Purchase Order

// Route for creating a Purchase Order
app.post('/api/purchase_orders', async (req, res) => {
	try {
		const { vendor_id, user_id, order_id } = req.body;

		// Check if a purchase order already exists for the given order_id and vendor_id
		const existingPurchaseOrder = await prisma.purchaseOrder.findFirst({
			where: {
				vendor_id: vendor_id,
				order_id: order_id,
			},
		});

		if (existingPurchaseOrder) {
			// A purchase order already exists, return it
			return res.json(existingPurchaseOrder);
		}

		// Create a new purchase order
		const purchaseOrder = await prisma.purchaseOrder.create({
			data: {
				vendor_id: vendor_id,
				user_id: user_id,
				order_id: order_id,
			},
			include: {
				vendor: true,
				user: true,
				order: true,
				purchaseOrderLineItems: {
					include: {
						purchaseOrder: true,
					},
				},
			},
		});

		res.json(purchaseOrder);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to create purchase order' });
	}
});

// Route for creating or updating a Purchase Order Line Item
app.post('/purchaseOrderLineItem', async (req, res) => {
	try {
		const {
			purchaseOrderId,
			vendorProductId,
			quantityPurchased,
			vendorCost,
			product_sku,
			vendor_sku,
		} = req.body;

		console.log(req.body);
		let purchaseOrderLineItem = await prisma.purchaseOrderLineItem.findFirst({
			where: {
				purchase_order_id: purchaseOrderId,
				product_sku: product_sku,
			},
		});

		console.log(purchaseOrderLineItem);

		if (!purchaseOrderLineItem) {
			purchaseOrderLineItem = await prisma.purchaseOrderLineItem.create({
				data: {
					purchase_order_id: purchaseOrderId,
					quantity_purchased: quantityPurchased,
					vendor_cost: vendorCost,
					product_sku: product_sku,
					vendor_sku: vendor_sku,
				},
			});
		} else {
			purchaseOrderLineItem = await prisma.purchaseOrderLineItem.update({
				where: {
					id: purchaseOrderLineItem.id,
				},
				data: {
					quantity_purchased: quantityPurchased,
					vendor_cost: vendorCost,
				},
			});
		}

		res.status(201).json(purchaseOrderLineItem);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Something went wrong' });
	}
});

// Route for updating a Purchase Order
app.post('/api/purchase_orders/:id/update', async (req, res) => {
	try {
		const purchaseOrder = await prisma.purchaseOrder.update({
			where: {
				id: Number(req.params.id),
			},
			data: {
				vendor_id: req.body.vendor_id,
				user_id: req.body.user_id,
				order_id: req.body.order_id,
			},
			include: {
				vendor: true,
				user: true,
				order: true,
				purchaseOrderLineItems: {
					include: {
						vendorProduct: true,
						purchaseOrder: true,
					},
				},
			},
		});
		res.json(purchaseOrder);
	} catch (error) {
		res.status(500).json({ error: 'Failed to update purchase order' });
	}
});

// Route for deleting a Purchase Order
app.post('/api/purchase_orders/:id/delete', async (req, res) => {
	try {
		const purchaseOrder = await prisma.purchaseOrder.delete({
			where: {
				id: Number(req.params.id),
			},
		});
		res.json(purchaseOrder);
	} catch (error) {
		res.status(500).json({ error: 'Failed to delete purchase order' });
	}
});

// Route for getting the grand total and total count of all orders
app.get('/totalOrderInfo', async (req, res) => {
	try {
		const result = await prisma.order.aggregate({
			_sum: {
				grand_total: true,
				total_qty_ordered: true,
			},
			_count: {
				_all: true,
			},
			_avg: {
				grand_total: true,
			},
		});
		const totalSum = result._sum.grand_total;
		const totalQty = result._sum.total_qty_ordered;
		const count = result._count._all;
		const avg = result._avg.grand_total;
		res.json({ totalSum, count, avg, totalQty });
	} catch (error) {
		console.error(`Error getting total sum of grand_total: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	} finally {
		await prisma.$disconnect();
	}
});

//Route for getting the total of all orders by month
app.get('/totalGrandTotalByMonth', async (req, res) => {
	try {
		const orders = await prisma.order.findMany();
		const totalByMonth = orders.reduce((acc, order) => {
			const month = format(parseISO(order.created_at), 'yyyy-MM');
			if (!acc[month]) {
				acc[month] = 0;
			}
			acc[month] += order.grand_total;
			return acc;
		}, {});
		const currentMonth = format(new Date(), 'yyyy-MM');
		const lastMonth = format(new Date().setDate(0), 'yyyy-MM');
		res.json({
			orders,
			total_by_month: totalByMonth,
			total_this_month: totalByMonth[currentMonth],
			total_last_month: totalByMonth[lastMonth],
		});
	} catch (error) {
		console.error(`Error getting total by month: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

// // Route for get all products info
app.get('/productinfo', async (req, res) => {
	try {
		const countProduct = await prisma.product.aggregate({
			_count: {
				_all: true,
			},
		});
		const orderProduct = await prisma.orderProduct.aggregate({
			_sum: {
				qty_ordered: true,
			},
		});
		res.json({
			numProduct: countProduct._count._all,
			totalSold: orderProduct._sum.qty_ordered,
		});
	} catch (error) {
		console.error(`Error getting products info: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

// Route for top 10 popular products
app.get('/toppopularproduct', async (req, res) => {
	const result3 = [];
	try {
		const result1 = await prisma.orderProduct.groupBy({
			by: ['sku'],
			_sum: {
				qty_ordered: true,
			},
			orderBy: {
				_sum: {
					qty_ordered: 'desc',
				},
			},
			take: 10,
		});
		// const result3 = result1.map(async (item) => {
		//   const result2 = await prisma.product.findUnique({
		//     where: {
		//       sku:item.sku,
		//     }
		//   });
		//   return result2;
		// })
		// const result = await Promise.all(result3);
		for (let i = 0; i < result1.length; i++) {
			const result2 = await prisma.product.findUnique({
				where: {
					sku: result1[i].sku,
				},
			});
			result3.push({ ...result1[i]._sum, ...result2 });
		}
		res.json(result3);
	} catch (error) {
		console.error(`Error getting top 10 popular products info: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

// Global error handler (Axiom)
app.use((err, req, res, next) => {
	logger.apiError(err, req);
	res.status(err.status || 500).json({
		error: process.env.NODE_ENV === 'production'
			? 'Internal Server Error'
			: err.message,
	});
});

// Graceful shutdown - disconnect Prisma and flush logs before exit
async function gracefulShutdown(signal) {
	logger.info(`${signal} received, shutting down gracefully`);
	try {
		await prisma.$disconnect();
		await logger.flush();
	} catch (e) {
		console.error('Error during shutdown:', e);
	}
	process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

function formatDuration(startTime) {
	return formatDurationMs(Date.now() - startTime);
}

function readLogExcerpt(logFile) {
	if (!logFile) return undefined;

	const resolvedPath = path.resolve(__dirname, logFile);
	if (!fs.existsSync(resolvedPath)) return undefined;

	try {
		const maxLines = Number(process.env.CRON_EMAIL_LOG_LINES || 20);
		const maxChars = Number(process.env.CRON_EMAIL_LOG_CHARS || 4000);
		const content = fs.readFileSync(resolvedPath, 'utf-8');
		const excerpt = content
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-maxLines)
			.join('\n')
			.slice(-maxChars)
			.trim();

		return excerpt || undefined;
	} catch (error) {
		logger.warn('Failed to read cron log excerpt', {
			logFile: resolvedPath,
			error: error.message,
		});
		return undefined;
	}
}

function buildSingleResult({ command, success, durationMs, logFile, error }) {
	return [{
		cmd: command,
		success,
		durationMs,
		logFile: logFile ? path.resolve(__dirname, logFile) : undefined,
		logExcerpt: readLogExcerpt(logFile),
		error,
	}];
}

function createCronLogWriter({ resolvedLogFile, jobName, command }) {
	if (!resolvedLogFile) return null;

	let failed = false;
	let stream = null;

	try {
		fs.mkdirSync(path.dirname(resolvedLogFile), { recursive: true });
		stream = fs.createWriteStream(resolvedLogFile, { flags: 'a' });
	} catch (error) {
		logger.error('Failed to open cron log file', {
			jobName,
			command,
			logFile: resolvedLogFile,
			error: error.message,
		});
		return null;
	}

	stream.on('error', (error) => {
		failed = true;
		logger.error('Cron log stream error; continuing without file logging', {
			jobName,
			command,
			logFile: resolvedLogFile,
			error: error.message,
		});
	});

	return {
		write(chunk) {
			if (failed || !stream || stream.destroyed) return;
			stream.write(chunk);
		},
		end(trailer) {
			if (failed || !stream || stream.destroyed) return Promise.resolve();

			return new Promise((resolve) => {
				const finish = () => resolve();
				stream.once('finish', finish);
				stream.once('error', finish);
				if (trailer) {
					stream.end(trailer);
				} else {
					stream.end();
				}
			});
		},
	};
}

function finalizeLogStream(logWriter, trailer) {
	if (!logWriter) return Promise.resolve();
	return logWriter.end(trailer);
}

async function deliverCronNotification({
	command,
	jobName,
	success,
	exitCode,
	error,
	duration,
	results,
	notifyOnSuccess = true,
}) {
	if (success && notifyOnSuccess === false) {
		logger.info('Cron success notification suppressed', {
			jobName,
			command,
		});
		return {
			success: true,
			mode: 'suppressed',
			fallbackUsed: false,
			message: 'Success notification suppressed by job configuration',
		};
	}

	const hasDetailedResults = Array.isArray(results) && results.length > 0;
	const primaryDelivery = hasDetailedResults
		? await sendCronReport({
			jobName,
			success,
			exitCode,
			error,
			duration,
			results,
		})
		: await sendCronNotification({
			jobName,
			success,
			exitCode,
			error,
			duration,
		});

	if (primaryDelivery?.success) {
		logger.info('Cron notification email delivered', {
			jobName,
			command,
			success,
			detailedReport: hasDetailedResults,
		});
		return {
			...primaryDelivery,
			mode: hasDetailedResults ? 'report' : 'summary',
			fallbackUsed: false,
		};
	}

	logger.error('Cron notification email failed', {
		jobName,
		command,
		success,
		detailedReport: hasDetailedResults,
		error: primaryDelivery?.error || primaryDelivery?.message || 'Unknown email delivery failure',
	});

	if (!hasDetailedResults) {
		return {
			...primaryDelivery,
			mode: 'summary',
			fallbackUsed: false,
		};
	}

	const fallbackDelivery = await sendCronNotification({
		jobName,
		success,
		exitCode,
		error,
		duration,
	});

	if (fallbackDelivery?.success) {
		logger.warn('Detailed cron report email failed; fallback summary email delivered', {
			jobName,
			command,
			success,
		});
		return {
			...fallbackDelivery,
			mode: 'summary',
			fallbackUsed: true,
		};
	}

	logger.error('Fallback cron notification email also failed', {
		jobName,
		command,
		success,
		error: fallbackDelivery?.error || fallbackDelivery?.message || 'Unknown fallback email failure',
	});

	return {
		...fallbackDelivery,
		mode: 'summary',
		fallbackUsed: true,
	};
}

function registerCommandCronJob({
	schedule,
	command,
	jobName,
	logPrefix,
	reportLogFile,
	readSummaryFile,
	notifyOnSuccess = true,
}) {
	let isRunning = false;
	upsertCronJobRecord(command, {
		jobName,
		schedule,
		logFile: reportLogFile ? path.resolve(__dirname, reportLogFile) : null,
		readSummaryFile: readSummaryFile ? path.resolve(__dirname, readSummaryFile) : null,
		isRunning: false,
		lastStatus: cronEnabled ? 'scheduled' : 'disabled',
	});

	logger.info('Registering cron job', {
		jobName,
		schedule,
		cronTimezone,
		command,
	});

	cron.schedule(schedule, () => {
		if (isRunning) {
			upsertCronJobRecord(command, {
				lastStatus: 'skipped',
				lastError: 'Previous run still in progress',
			});
			logger.warn('Cron job skipped because previous run is still active', {
				jobName,
				schedule,
				command,
			});
			console.log(`⏭️ [CRON] Skipping ${jobName}; previous run is still in progress`);
			return;
		}

		if (activeCommandCronJob) {
			const activeJobLabel = activeCommandCronJob.jobName || activeCommandCronJob.command;
			upsertCronJobRecord(command, {
				lastStatus: 'skipped',
				lastError: `Skipped because ${activeJobLabel} is already running`,
			});
			logger.warn('Cron job skipped because another command cron job is already active', {
				jobName,
				schedule,
				command,
				activeJob: activeCommandCronJob,
			});
			console.log(`⏭️ [CRON] Skipping ${jobName}; ${activeJobLabel} is already running`);
			return;
		}

		isRunning = true;
		const startTime = Date.now();
		activeCommandCronJob = {
			command,
			jobName,
			startedAt: new Date(startTime).toISOString(),
		};
		upsertCronJobRecord(command, {
			isRunning: true,
			lastStatus: 'running',
			lastStartedAt: new Date(startTime).toISOString(),
			lastError: null,
			progress: null,
		});
		logger.info('🕐 Cron job started', {
			jobName,
			schedule,
			timezone: cronTimezone,
			command,
		});
		console.log(`🕐 [CRON] Starting ${jobName} with command "npm run ${command}" on schedule ${schedule} (${cronTimezone})...`);

		const resolvedLogFile = reportLogFile ? path.resolve(__dirname, reportLogFile) : null;
		const logStream = createCronLogWriter({ resolvedLogFile, jobName, command });
		if (logStream) {
			logStream.write(`\n${'='.repeat(80)}\n`);
			logStream.write(`[${new Date().toISOString()}] Starting ${jobName} (npm run ${command})\n`);
		}

		const seedProcess = spawn('npm', ['run', command], {
			cwd: __dirname,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: true,
		});

		let timedOut = false;
		const timeoutHandle = Number.isFinite(cronChildTimeoutMs) && cronChildTimeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				const timeoutMessage = `Process timed out after ${cronChildTimeoutMs}ms`;
				logger.error('⏰ Cron job timed out; terminating process', {
					jobName,
					command,
					timeoutMs: cronChildTimeoutMs,
					graceMs: cronChildKillGraceMs,
				});
				if (logStream) {
					logStream.write(`[${new Date().toISOString()}] ${timeoutMessage}\n`);
				}
				seedProcess.kill('SIGTERM');
				setTimeout(() => {
					seedProcess.kill('SIGKILL');
				}, cronChildKillGraceMs);
			}, cronChildTimeoutMs)
			: null;

		if (seedProcess.stdout) {
			seedProcess.stdout.on('data', (chunk) => {
				process.stdout.write(chunk);
				if (logStream) logStream.write(chunk);
			});
		}

		if (seedProcess.stderr) {
			seedProcess.stderr.on('data', (chunk) => {
				process.stderr.write(chunk);
				if (logStream) logStream.write(chunk);
			});
		}

		seedProcess.on('close', async (code, signal) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			const duration = formatDuration(startTime);
			const durationMs = Date.now() - startTime;
			const startedAt = new Date(startTime).toISOString();
			const finishedAt = new Date().toISOString();
			const exitLabel = formatCronExitLabel(code, signal);
			let summary = null;
			await finalizeLogStream(
				logStream,
				`\n[${new Date().toISOString()}] Finished ${jobName} with ${exitLabel}\n`
			);

			if (readSummaryFile) {
				const summaryFile = path.resolve(__dirname, readSummaryFile);
				if (fs.existsSync(summaryFile)) {
					try {
						summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
					} catch (readErr) {
						logger.error('⚠️ Failed to read cron summary file', {
							jobName,
							summaryFile,
							error: readErr.message,
						});
					}
				}
			}

			try {
				let notificationResult = null;
				if (code === 0) {
					logger.info('✅ Cron job completed successfully', { jobName, duration, command });
					console.log(`✅ [CRON] ${logPrefix} completed successfully`);

					if (summary && Array.isArray(summary.results)) {
						notificationResult = await deliverCronNotification({
							command,
							jobName,
							success: true,
							exitCode: code,
							duration,
							results: summary.results,
							notifyOnSuccess,
						});
					} else {
						notificationResult = await deliverCronNotification({
							command,
							jobName,
							success: true,
							exitCode: code,
							duration,
							results: buildSingleResult({
								command,
								success: true,
								durationMs,
								logFile: reportLogFile,
							}),
							notifyOnSuccess,
						});
					}

					upsertCronJobRecord(command, {
						isRunning: false,
						lastStatus: 'success',
						lastFinishedAt: finishedAt,
						lastDurationMs: durationMs,
						lastDurationLabel: duration,
						lastExitCode: code,
						lastError: null,
						lastNotification: buildNotificationSnapshot(notificationResult),
						summary: summarizeCronResults(summary?.results),
						failedResults: [],
					});
					recordCronRunHistory({
						command,
						jobName,
						status: 'success',
						startedAt,
						finishedAt,
						durationMs,
						durationLabel: duration,
						exitCode: code,
						notification: buildNotificationSnapshot(notificationResult),
						summary: summarizeCronResults(summary?.results),
						failedResults: [],
					});
				} else {
					const error = timedOut
						? `Process timed out after ${cronChildTimeoutMs}ms`
						: `Process ended with ${exitLabel}`;
					const failedResults = extractFailedCronResults(summary?.results);
					const failedDetails = formatFailedCronResults(failedResults);
					const detailedError = failedDetails ? `${error} | Failed steps: ${failedDetails}` : error;
					logger.error('❌ Cron job failed', { jobName, exitCode: code, signal, duration, command });
					console.error(`❌ [CRON] ${logPrefix} failed with ${exitLabel}`);

					if (summary && Array.isArray(summary.results)) {
						notificationResult = await deliverCronNotification({
							command,
							jobName,
							success: false,
							exitCode: code,
							error: detailedError,
							duration,
							results: summary.results,
						});
					} else {
						notificationResult = await deliverCronNotification({
							command,
							jobName,
							success: false,
							exitCode: code,
							error: detailedError,
							duration,
							results: buildSingleResult({
								command,
								success: false,
								durationMs,
								logFile: reportLogFile,
								error: detailedError,
							}),
						});
					}

					upsertCronJobRecord(command, {
						isRunning: false,
						lastStatus: 'failed',
						lastFinishedAt: finishedAt,
						lastDurationMs: durationMs,
						lastDurationLabel: duration,
						lastExitCode: code,
						lastError: detailedError,
						lastNotification: buildNotificationSnapshot(notificationResult),
						summary: summarizeCronResults(summary?.results),
						failedResults,
					});
					recordCronRunHistory({
						command,
						jobName,
						status: 'failed',
						startedAt,
						finishedAt,
						durationMs,
						durationLabel: duration,
						exitCode: code,
						error: detailedError,
						notification: buildNotificationSnapshot(notificationResult),
						summary: summarizeCronResults(summary?.results),
						failedResults,
					});
				}
			} finally {
				isRunning = false;
				if (activeCommandCronJob?.command === command) {
					activeCommandCronJob = null;
				}
			}
		});

		seedProcess.on('error', async (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			const duration = formatDuration(startTime);
			const durationMs = Date.now() - startTime;
			const startedAt = new Date(startTime).toISOString();
			const finishedAt = new Date().toISOString();
			await finalizeLogStream(
				logStream,
				`\n[${new Date().toISOString()}] Failed to start ${jobName}: ${error.message}\n`
			);
			logger.error('❌ Cron job error: Failed to start command', {
				jobName,
				command,
				error: error.message,
				duration,
			});
			console.error(`❌ [CRON] Error running ${jobName}:`, error.message);

			try {
				const notificationResult = await deliverCronNotification({
					command,
					jobName,
					success: false,
					error: error.message,
					duration,
					results: buildSingleResult({
						command,
						success: false,
						durationMs,
						logFile: reportLogFile,
						error: error.message,
					}),
				});

				upsertCronJobRecord(command, {
					isRunning: false,
					lastStatus: 'failed',
					lastFinishedAt: finishedAt,
					lastDurationMs: durationMs,
					lastDurationLabel: duration,
					lastExitCode: null,
					lastError: error.message,
					lastNotification: buildNotificationSnapshot(notificationResult),
					failedResults: [],
				});
				recordCronRunHistory({
					command,
					jobName,
					status: 'failed',
					startedAt,
					finishedAt,
					durationMs,
					durationLabel: duration,
					error: error.message,
					notification: buildNotificationSnapshot(notificationResult),
					failedResults: [],
				});
			} finally {
				isRunning = false;
				if (activeCommandCronJob?.command === command) {
					activeCommandCronJob = null;
				}
			}
		});
	}, {
		scheduled: true,
		timezone: cronTimezone,
	});
}

function markReportCronScheduled({ command, jobName, schedule, timezone }) {
	upsertCronJobRecord(command, {
		jobName,
		schedule,
		isRunning: false,
		lastStatus: cronEnabled ? 'scheduled' : 'disabled',
		timezone,
	});
}

function markReportCronSkipped({ command, message }) {
	upsertCronJobRecord(command, {
		isRunning: false,
		lastStatus: 'skipped',
		lastError: message,
	});
	appendReportCronLogLine(command, `[${new Date().toISOString()}] Skipped ${command}: ${message}`);
}

function appendReportCronLogLine(command, line) {
	const definition = getCronJobDefinitionByCommand(command);
	if (!definition?.reportLogFile) return;

	const resolvedLogFile = path.resolve(__dirname, definition.reportLogFile);
	try {
		fs.mkdirSync(path.dirname(resolvedLogFile), { recursive: true });
		fs.appendFileSync(resolvedLogFile, `${line}\n`);
	} catch (error) {
		logger.warn('Failed to append report cron log line', {
			command,
			filePath: resolvedLogFile,
			error: error.message,
		});
	}
}

function markReportCronStarted({ command, startedAt }) {
	appendReportCronLogLine(command, `${'='.repeat(80)}`);
	appendReportCronLogLine(command, `[${new Date().toISOString()}] Starting ${command}`);
	upsertCronJobRecord(command, {
		isRunning: true,
		lastStatus: 'running',
		lastStartedAt: startedAt,
		lastError: null,
		progress: null,
	});
}

function markReportCronFinished({ command, jobName, startedAt, finishedAt, durationMs, durationLabel, status, error, summary }) {
	const isSuccess = status === 'success';
	const failedResults = isSuccess ? [] : [{ cmd: command, code: null, error }];
	const notification = { success: isSuccess, mode: 'report-email', fallbackUsed: false, message: error || null, updatedAt: finishedAt };
	appendReportCronLogLine(command, `[${finishedAt}] Finished ${jobName} with exit code ${isSuccess ? 0 : 1}`);
	if (error) {
		appendReportCronLogLine(command, `[${finishedAt}] Error: ${error}`);
	}

	upsertCronJobRecord(command, {
		isRunning: false,
		lastStatus: status,
		lastFinishedAt: finishedAt,
		lastDurationMs: durationMs,
		lastDurationLabel: durationLabel,
		lastExitCode: isSuccess ? 0 : 1,
		lastError: error || null,
		lastNotification: notification,
		summary: summary || null,
		failedResults,
	});

	recordCronRunHistory({
		command,
		jobName,
		status,
		startedAt,
		finishedAt,
		durationMs,
		durationLabel,
		exitCode: isSuccess ? 0 : 1,
		error: error || null,
		notification,
		summary: summary || null,
		failedResults,
	});
}

// Guard-rail anti-drift: todo command cron faz spawn de "npm run <command>".
// Se o script sumir do package.json (ex.: revert acidental como o 81047cf), o
// job falharia em TODO disparo com "Missing script" + email de erro. Aqui a
// falha vira: log alto no boot, registro "invalid" no dashboard /api/cron-jobs,
// UM email agregado e o job fica sem agendar (a API continua de pe).
function validateCronCommandScripts(definitions) {
	const packageScripts = require('./package.json').scripts || {};
	const valid = [];
	const invalid = [];

	for (const definition of definitions) {
		if (Object.prototype.hasOwnProperty.call(packageScripts, definition.command)) {
			valid.push(definition);
			continue;
		}

		invalid.push(definition);
		logger.error('CRON MISCONFIGURED: npm script missing from package.json — job will NOT be scheduled', {
			command: definition.command,
			jobName: definition.jobName,
			schedule: definition.schedule,
		});
		console.error(`❌ [CRON] Job "${definition.jobName}" NAO agendado: npm script "${definition.command}" nao existe no package.json`);
		upsertCronJobRecord(definition.command, {
			jobName: definition.jobName,
			schedule: definition.schedule,
			logFile: definition.reportLogFile ? path.resolve(__dirname, definition.reportLogFile) : null,
			isRunning: false,
			lastStatus: 'invalid',
			lastError: `npm script "${definition.command}" missing from package.json`,
		});
	}

	if (invalid.length > 0) {
		const summary = invalid
			.map((definition) => `${definition.jobName} -> npm run ${definition.command} (schedule: ${definition.schedule})`)
			.join('; ');
		deliverCronNotification({
			command: 'cron-config-validation',
			jobName: 'Cron Configuration Validation',
			success: false,
			exitCode: null,
			error: `${invalid.length} cron job(s) reference npm scripts that do not exist in package.json: ${summary}`,
			duration: null,
			notifyOnSuccess: false,
		}).catch((notifyError) => {
			logger.error('Failed to send cron misconfiguration alert email', {
				error: notifyError?.message || notifyError,
			});
		});
	}

	return valid;
}

function registerCronJobs() {
	if (cronJobsRegistered) {
		logger.warn('Cron jobs already registered; skipping duplicate initialization');
		return;
	}

	if (!cronEnabled) {
		logger.info('Cron jobs disabled via CRON_ENABLED=false');
		cronJobsRegistered = true;
		return;
	}

	for (const definition of validateCronCommandScripts(getCronJobDefinitions())) {
		registerCommandCronJob(definition);
	}

	cronJobsRegistered = true;

	for (const definition of getReportCronJobDefinitions()) {
		markReportCronScheduled(definition);
	}

	if (!testCronEnabled) {
		logger.info('Test cron job disabled via CRON_TEST_ENABLED=false');
	}

	if (cancellationReportEnabled) {
		const cancellationReportCommand = 'report-order-cancellations-daily';
		const cancellationReportJobName = 'Daily Cancelled Orders Report';
		let cancellationReportRunning = false;
		logger.info('Registering cancellation daily report cron job', {
			schedule: cancellationReportSchedule,
			timezone: cancellationReportTimezone,
		});

		cron.schedule(cancellationReportSchedule, async () => {
			if (cancellationReportRunning) {
				markReportCronSkipped({
					command: cancellationReportCommand,
					message: 'Previous run still in progress',
				});
				logger.warn('Cancellation daily report skipped because previous run is still in progress');
				return;
			}

			cancellationReportRunning = true;
			const startedAt = Date.now();
			const startedAtIso = new Date(startedAt).toISOString();
			const reportDate = getDateStringInTimezone(new Date(), cancellationReportTimezone || 'America/Toronto');
			markReportCronStarted({ command: cancellationReportCommand, startedAt: startedAtIso });

			try {
				const result = await sendDailyCancellationReportEmailForDate(reportDate, {
					timeZone: cancellationReportTimezone,
				});
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: cancellationReportCommand,
					jobName: cancellationReportJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'success',
					summary: {
						totalCancelled: result.report.totalCancelled,
						paulaCancelled: result.report.paulaCancelled,
					},
				});
				logger.info('Daily cancellation report email sent', {
					reportDate,
					totalCancelled: result.report.totalCancelled,
					paulaCancelled: result.report.paulaCancelled,
					duration: durationLabel,
				});
			} catch (error) {
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: cancellationReportCommand,
					jobName: cancellationReportJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'failed',
					error: error.message,
				});
				logger.error('Failed to send daily cancellation report email', {
					reportDate,
					error: error.message,
					duration: durationLabel,
				});
			} finally {
				cancellationReportRunning = false;
			}
		}, {
			scheduled: true,
			timezone: cancellationReportTimezone,
		});
	} else {
		logger.info('Cancellation daily report cron job disabled via CRON_CANCELLATION_REPORT_ENABLED=false');
	}

	if (skuStatusReportEnabled) {
		const skuStatusReportCommand = 'report-sku-status-daily';
		const skuStatusReportJobName = 'Daily SKU Status Change Report';
		let skuStatusReportRunning = false;
		logger.info('Registering SKU status daily report cron job', {
			schedule: skuStatusReportSchedule,
			timezone: skuStatusReportTimezone,
		});

		cron.schedule(skuStatusReportSchedule, async () => {
			if (skuStatusReportRunning) {
				markReportCronSkipped({
					command: skuStatusReportCommand,
					message: 'Previous run still in progress',
				});
				logger.warn('SKU status daily report skipped because previous run is still in progress');
				return;
			}

			skuStatusReportRunning = true;
			const startedAt = Date.now();
			const startedAtIso = new Date(startedAt).toISOString();
			const reportDate = getDateStringInTimezone(new Date(), skuStatusReportTimezone || 'America/Toronto');
			markReportCronStarted({ command: skuStatusReportCommand, startedAt: startedAtIso });

			try {
				const result = await sendDailySkuStatusReportEmailForDate(reportDate, {
					timeZone: skuStatusReportTimezone,
				});
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: skuStatusReportCommand,
					jobName: skuStatusReportJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'success',
					summary: {
						totalChanged: result.report.totalChanged,
						totalDisabled: result.report.totalDisabled,
						totalEnabled: result.report.totalEnabled,
					},
				});
				logger.info('Daily SKU status report email sent', {
					reportDate,
					totalChanged: result.report.totalChanged,
					totalDisabled: result.report.totalDisabled,
					totalEnabled: result.report.totalEnabled,
					duration: durationLabel,
				});
			} catch (error) {
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: skuStatusReportCommand,
					jobName: skuStatusReportJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'failed',
					error: error.message,
				});
				logger.error('Failed to send daily SKU status report email', {
					reportDate,
					error: error.message,
					duration: durationLabel,
				});
			} finally {
				skuStatusReportRunning = false;
			}
		}, {
			scheduled: true,
			timezone: skuStatusReportTimezone,
		});
	} else {
		logger.info('SKU status daily report cron job disabled via CRON_SKU_STATUS_REPORT_ENABLED=false');
	}

	if (skuStatusWeeklyReportEnabled) {
		const skuStatusWeeklyReportCommand = 'report-sku-status-weekly';
		const skuStatusWeeklyReportJobName = 'Weekly SKU Status Change Report';
		let skuStatusWeeklyReportRunning = false;
		logger.info('Registering SKU status weekly report cron job', {
			schedule: skuStatusWeeklyReportSchedule,
			timezone: skuStatusWeeklyReportTimezone,
		});

		cron.schedule(skuStatusWeeklyReportSchedule, async () => {
			if (skuStatusWeeklyReportRunning) {
				markReportCronSkipped({
					command: skuStatusWeeklyReportCommand,
					message: 'Previous run still in progress',
				});
				logger.warn('SKU status weekly report skipped because previous run is still in progress');
				return;
			}

			skuStatusWeeklyReportRunning = true;
			const startedAt = Date.now();
			const startedAtIso = new Date(startedAt).toISOString();
			const reportEndDate = getDateStringInTimezone(new Date(), skuStatusWeeklyReportTimezone || 'America/Toronto');
			markReportCronStarted({ command: skuStatusWeeklyReportCommand, startedAt: startedAtIso });

			try {
				const result = await sendWeeklySkuStatusReportEmailForDate(reportEndDate, {
					timeZone: skuStatusWeeklyReportTimezone,
				});
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: skuStatusWeeklyReportCommand,
					jobName: skuStatusWeeklyReportJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'success',
					summary: {
						totalChanged: result.report.totalChanged,
						totalDisabled: result.report.totalDisabled,
						totalEnabled: result.report.totalEnabled,
					},
				});
				logger.info('Weekly SKU status report email sent', {
					reportStartDate: result.report.startDate,
					reportEndDate: result.report.endDate,
					totalChanged: result.report.totalChanged,
					totalDisabled: result.report.totalDisabled,
					totalEnabled: result.report.totalEnabled,
					duration: durationLabel,
				});
			} catch (error) {
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: skuStatusWeeklyReportCommand,
					jobName: skuStatusWeeklyReportJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'failed',
					error: error.message,
				});
				logger.error('Failed to send weekly SKU status report email', {
					reportEndDate,
					error: error.message,
					duration: durationLabel,
				});
			} finally {
				skuStatusWeeklyReportRunning = false;
			}
		}, {
			scheduled: true,
			timezone: skuStatusWeeklyReportTimezone,
		});
	} else {
		logger.info('SKU status weekly report cron job disabled via CRON_SKU_STATUS_WEEKLY_REPORT_ENABLED=false');
	}

	if (cronDigestEnabled) {
		const cronDigestCommand = 'report-cron-digest-daily';
		const cronDigestJobName = 'Daily Cron Activity Digest';
		let cronDigestRunning = false;
		logger.info('Registering daily cron activity digest job', {
			schedule: cronDigestSchedule,
			timezone: cronDigestTimezone,
		});

		cron.schedule(cronDigestSchedule, async () => {
			if (cronDigestRunning) {
				markReportCronSkipped({
					command: cronDigestCommand,
					message: 'Previous run still in progress',
				});
				logger.warn('Daily cron activity digest skipped because previous run is still in progress');
				return;
			}

			cronDigestRunning = true;
			const startedAt = Date.now();
			const startedAtIso = new Date(startedAt).toISOString();
			markReportCronStarted({ command: cronDigestCommand, startedAt: startedAtIso });

			try {
				const results = buildCronDigestResults({ lookbackHours: 24 });
				const digestSuccess = results.every((result) => result.success);
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				const delivery = await sendCronReport({
					jobName: cronDigestJobName,
					success: digestSuccess,
					exitCode: digestSuccess ? 0 : 1,
					duration: durationLabel,
					results,
				});

				if (!delivery?.success) {
					throw new Error(delivery?.error || delivery?.message || 'Failed to send daily cron activity digest');
				}

				const finishedAt = new Date().toISOString();
				markReportCronFinished({
					command: cronDigestCommand,
					jobName: cronDigestJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'success',
					summary: summarizeCronResults(results),
				});
				logger.info('Daily cron activity digest email sent', {
					results: results.length,
					duration: durationLabel,
				});
			} catch (error) {
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - startedAt;
				const durationLabel = formatDuration(startedAt);
				markReportCronFinished({
					command: cronDigestCommand,
					jobName: cronDigestJobName,
					startedAt: startedAtIso,
					finishedAt,
					durationMs,
					durationLabel,
					status: 'failed',
					error: error.message,
				});
				logger.error('Failed to send daily cron activity digest email', {
					error: error.message,
					duration: durationLabel,
				});
			} finally {
				cronDigestRunning = false;
			}
		}, {
			scheduled: true,
			timezone: cronDigestTimezone,
		});
	} else {
		logger.info('Daily cron activity digest disabled via CRON_DIGEST_ENABLED=false');
	}

	if (qbFreshnessReportEnabled) {
		const qbFreshnessCommand = 'report-quickbooks-freshness';
		const qbFreshnessJobName = 'QuickBooks Data Freshness Check';
		let qbFreshnessRunning = false;
		logger.info('Registering QuickBooks data freshness check cron job', {
			schedule: qbFreshnessReportSchedule,
			timezone: qbFreshnessReportTimezone,
			warnDays: qbStaleWarnDays,
			critDays: qbStaleCritDays,
		});

		cron.schedule(qbFreshnessReportSchedule, async () => {
			if (qbFreshnessRunning) {
				markReportCronSkipped({
					command: qbFreshnessCommand,
					message: 'Previous run still in progress',
				});
				return;
			}

			qbFreshnessRunning = true;
			const startedAt = Date.now();
			const startedAtIso = new Date(startedAt).toISOString();
			markReportCronStarted({ command: qbFreshnessCommand, startedAt: startedAtIso });

			try {
				// Idade real do snapshot: no modo db vem do import (sourceExportedAt =
				// mtime do export); no modo csv, do mtime dos proprios arquivos.
				let referenceIso = null;
				if (isQuickBooksDbSource()) {
					const meta = await getQuickBooksLookupMeta();
					referenceIso = meta.sourceExportedAt || meta.lastImportAt || null;
				} else {
					const { CUSTOMER_CSV_PATH, TRANSACTION_CSV_PATH } = require('./services/quickbooksCustomerLookup');
					const mtimes = [CUSTOMER_CSV_PATH, TRANSACTION_CSV_PATH]
						.filter((filePath) => fs.existsSync(filePath))
						.map((filePath) => fs.statSync(filePath).mtime.getTime());
					referenceIso = mtimes.length ? new Date(Math.min(...mtimes)).toISOString() : null;
				}

				const ageDays = referenceIso
					? Number(((Date.now() - Date.parse(referenceIso)) / 86400000).toFixed(1))
					: null;
				const level = ageDays === null
					? 'missing'
					: ageDays > qbStaleCritDays
						? 'critical'
						: ageDays > qbStaleWarnDays
							? 'warning'
							: 'ok';

				const summary = {
					ageDays,
					dataAsOf: referenceIso,
					warnDays: qbStaleWarnDays,
					critDays: qbStaleCritDays,
					level,
					source: isQuickBooksDbSource() ? 'db' : 'csv',
				};

				if (level === 'ok') {
					logger.info('QuickBooks lookup data freshness ok', summary);
				} else {
					const message = level === 'missing'
						? 'QuickBooks lookup data missing: no import/CSV found'
						: `QuickBooks lookup data is ${ageDays} days old (as of ${referenceIso})`;

					if (level === 'warning') {
						logger.warn(message, summary);
					} else {
						logger.error(message, summary);
					}

					await sendCronReport({
						jobName: qbFreshnessJobName,
						success: false,
						exitCode: 1,
						error: message,
						duration: formatDuration(startedAt),
						results: [{
							cmd: qbFreshnessCommand,
							success: false,
							durationMs: Date.now() - startedAt,
							error: `${message}. Rode a atualizacao: docs/QUICKBOOKS-DATA-REFRESH.md`,
						}],
					});
				}

				markReportCronFinished({
					command: qbFreshnessCommand,
					jobName: qbFreshnessJobName,
					startedAt: startedAtIso,
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - startedAt,
					durationLabel: formatDuration(startedAt),
					status: level === 'ok' || level === 'warning' ? 'success' : 'failed',
					summary,
				});
			} catch (error) {
				markReportCronFinished({
					command: qbFreshnessCommand,
					jobName: qbFreshnessJobName,
					startedAt: startedAtIso,
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - startedAt,
					durationLabel: formatDuration(startedAt),
					status: 'failed',
					error: error.message,
				});
				logger.error('QuickBooks data freshness check failed', {
					error: error.message,
				});
			} finally {
				qbFreshnessRunning = false;
			}
		}, {
			scheduled: true,
			timezone: qbFreshnessReportTimezone,
		});
	} else {
		logger.info('QuickBooks data freshness check disabled via CRON_QB_FRESHNESS_REPORT_ENABLED=false');
	}
}

backfillSkuStatusHistoryFromFileToDatabase().catch((error) => {
	logger.warn('SKU status report history backfill failed during startup', {
		error: error.message,
	});
});

backfillCancelWorkflowHistoryFromFileToDatabase().catch((error) => {
	logger.warn('Order cancellation workflow history backfill failed during startup', {
		error: error.message,
	});
});

registerCronJobs();

app.listen(PORT, () => {
	logger.info(`Server started on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV });
	console.log(
		`Express seems to be listening on port ${PORT} so that's pretty good 👍`
	);
	if (cronEnabled) {
		for (const definition of getCronJobDefinitions()) {
			console.log(
				`🕐 [CRON] ${definition.jobName} scheduled for ${definition.schedule} (${cronTimezone}) using npm run ${definition.command}`
			);
		}
		if (cancellationReportEnabled) {
			console.log(
				`🕐 [CRON] Daily cancellation report scheduled for ${cancellationReportSchedule} (${cancellationReportTimezone})`
			);
		}
		if (skuStatusReportEnabled) {
			console.log(
				`🕐 [CRON] Daily SKU status report scheduled for ${skuStatusReportSchedule} (${skuStatusReportTimezone})`
			);
		}
		if (skuStatusWeeklyReportEnabled) {
			console.log(
				`🕐 [CRON] Weekly SKU status report scheduled for ${skuStatusWeeklyReportSchedule} (${skuStatusWeeklyReportTimezone})`
			);
		}
		if (cronDigestEnabled) {
			console.log(
				`🕐 [CRON] Daily cron activity digest scheduled for ${cronDigestSchedule} (${cronDigestTimezone})`
			);
		}
	} else {
		console.log('🕐 [CRON] Cron jobs disabled via CRON_ENABLED=false');
	}
	console.log('📧 [EMAIL] Notifications will be sent to:', process.env.CRON_NOTIFICATION_EMAIL || 'tsantos@justjeeps.com');
	scheduleQuickBooksLookupPreload();
});
