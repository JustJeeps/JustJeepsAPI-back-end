// Checks that a feed file really is the canonical file it is claimed to be,
// by its column signature (config/feeds.js fileSpecs), on the server side.
// The panel detects the file in the browser, but the panel can be bypassed and
// the CLI exists, so the stored object (or the file on disk) is what gets
// verified before it enters the catalog.
//
// Only the head of the file is read: a CSV through a ranged GET of the first
// 64KB (SpecialOrder.csv is 460MB), an Excel file in full but bounded by the
// feed's maxUploadBytes (xlsx is a zip, the header cannot be read from a
// prefix). The pure rules live in lib/feeds/fileSignature.js; this module only
// gets the bytes and words the result.
//
// store is injected (same pattern as keystoneFetchService); the local file
// helpers need no store and are what the legacy upload route, the CLI and the
// Keystone fetch use.

const fs = require('fs');
const path = require('path');

const defaultFeedsConfig = require('../../config/feeds');
const { findHeaderRow, diffSignature, classify } = require('../../lib/feeds/fileSignature');
const { readHeaderRows, isCsvName, CSV_HEAD_BYTES } = require('../../lib/feeds/readHeaderRows');

const MISMATCH_CODE = 'FEED_FILE_SIGNATURE_MISMATCH';

// First CSV_HEAD_BYTES of a file on disk (a CSV), or the whole file (Excel).
function readLocalHead(filePath, fileName = filePath) {
	if (!isCsvName(fileName)) return { buffer: fs.readFileSync(filePath), truncated: false };
	const fd = fs.openSync(filePath, 'r');
	try {
		const buffer = Buffer.alloc(CSV_HEAD_BYTES);
		const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
		return { buffer: buffer.subarray(0, bytes), truncated: fs.fstatSync(fd).size > bytes };
	} finally {
		fs.closeSync(fd);
	}
}

const listColumns = (columns) => columns.map((column) => `"${column}"`).join(', ');

// Plain words for the person who dropped the file: which file it was taken
// for, and what differs. Nothing in it tells people to rename anything.
function describeMismatch({ spec, missing, extra, reason }) {
	const expected = `${spec.label} (${spec.name})`;
	if (reason) return `The file uploaded as ${expected} could not be checked: ${reason}.`;
	const parts = [];
	if (missing.length > 0) parts.push(`missing columns: ${listColumns(missing)}`);
	if (extra.length > 0) parts.push(`unexpected columns: ${listColumns(extra)}`);
	if (parts.length === 0) parts.push('the columns are the expected ones but in a different order');
	return `The file uploaded as ${expected} has different columns than that file (${parts.join('; ')}). Check that you picked the right file, or that the vendor did not change its layout.`;
}

// PURE: rows already read -> { ok, headerRowIndex } or { ok: false, missing,
// extra, foundRowIndex, message }.
function verifyRows(rows, spec) {
	const headerRowIndex = findHeaderRow(rows, spec.signature);
	if (headerRowIndex >= 0) return { ok: true, headerRowIndex };
	const diff = diffSignature(rows, spec.signature);
	return { ok: false, ...diff, message: describeMismatch({ spec, missing: diff.missing, extra: diff.extra }) };
}

const unreadable = (spec, error) => ({
	ok: false,
	missing: [],
	extra: [],
	foundRowIndex: -1,
	message: describeMismatch({ spec, reason: error.message }),
});

// A buffer of the head of the file -> verify result. Parse errors (not an
// xlsx at all, the named sheet is missing) are a mismatch too, worded as such.
function verifyBuffer(buffer, { spec, fileName, truncated = false }) {
	let rows;
	try {
		rows = readHeaderRows(buffer, { fileName, sheet: spec.sheet, truncated });
	} catch (error) {
		return unreadable(spec, error);
	}
	return verifyRows(rows, spec);
}

const mismatchError = (result, { feed, fileName }) => {
	const error = new Error(result.message);
	error.code = MISMATCH_CODE;
	error.feed = feed;
	error.fileName = fileName;
	error.missing = result.missing;
	error.extra = result.extra;
	return error;
};

const specOrThrow = (feedsConfig, feed, fileName) => {
	const spec = feedsConfig.getFileSpec(feed, fileName);
	if (!spec) {
		const error = new Error(`Feed ${typeof feed === 'string' ? feed : feed.name} has no file named ${fileName}`);
		error.code = 'FEED_FILE_MISMATCH';
		throw error;
	}
	return spec;
};

// File on disk claimed to be `fileName` of `feed` -> verify result.
function verifyLocalFile(filePath, { feed, fileName, feedsConfig = defaultFeedsConfig }) {
	const spec = specOrThrow(feedsConfig, feed, fileName);
	const { buffer, truncated } = readLocalHead(filePath, fileName);
	return verifyBuffer(buffer, { spec, fileName, truncated });
}

// Which canonical file of `feed` (or of any feed, when feed is null) is this
// file on disk? Reads the head once per distinct sheet the candidates name.
// originalName is the name the file arrived with, only used to break a tie
// between files that share a signature (Keystone).
function classifyLocalFile(filePath, { feed = null, originalName = path.basename(filePath), feedsConfig = defaultFeedsConfig } = {}) {
	const candidates = feedsConfig.getAllFileSpecs().filter((spec) => !feed || spec.feed === feed);
	const isCsv = isCsvName(originalName);
	const { buffer, truncated } = readLocalHead(filePath, originalName);
	const rowsBySheet = new Map();
	const rowsFor = (sheet) => {
		const key = isCsv ? '' : sheet || '';
		if (!rowsBySheet.has(key)) {
			let rows = [];
			try {
				rows = readHeaderRows(buffer, { fileName: originalName, sheet: isCsv ? null : sheet, truncated });
			} catch (error) {
				if (error.code !== 'FEED_SHEET_NOT_FOUND') throw error;
			}
			rowsBySheet.set(key, rows);
		}
		return rowsBySheet.get(key);
	};
	// CSV candidates only make sense for a CSV and Excel ones for a workbook;
	// a CSV never parses as a zip and the other way round.
	const usable = candidates.filter((spec) => isCsvName(spec.fileName) === isCsv);
	const result = classify(rowsFor(null), usable, { originalName, rowsForSheet: rowsFor });
	return { ...result, rows: rowsFor(null) };
}

// Store-backed check of an object already in the bucket, used by the direct
// upload route after the multipart completes.
function createSignatureCheck({ store, feedsConfig = defaultFeedsConfig }) {
	async function readStoredHead(key, fileName, maxBytes) {
		if (isCsvName(fileName)) {
			const { buffer, totalBytes } = await store.getObjectRange(key, CSV_HEAD_BYTES);
			return { buffer, truncated: totalBytes > buffer.length };
		}
		const { body, contentLength } = await store.getObjectStream(key);
		if (maxBytes && Number(contentLength) > maxBytes) {
			const error = new Error(`object is ${contentLength} bytes, above the ${maxBytes} byte limit`);
			error.code = 'FEED_FILE_TOO_LARGE';
			throw error;
		}
		const chunks = [];
		for await (const chunk of body) chunks.push(Buffer.from(chunk));
		return { buffer: Buffer.concat(chunks), truncated: false };
	}

	async function verifyStoredObject({ feed, fileName, key, maxBytes = null }) {
		const spec = specOrThrow(feedsConfig, feed, fileName);
		const { buffer, truncated } = await readStoredHead(key, fileName, maxBytes);
		return verifyBuffer(buffer, { spec, fileName, truncated });
	}

	return {
		verifyStoredObject,
		verifyLocalFile: (filePath, options) => verifyLocalFile(filePath, { feedsConfig, ...options }),
		classifyLocalFile: (filePath, options) => classifyLocalFile(filePath, { feedsConfig, ...options }),
	};
}

module.exports = {
	MISMATCH_CODE,
	createSignatureCheck,
	verifyRows,
	verifyBuffer,
	verifyLocalFile,
	classifyLocalFile,
	describeMismatch,
	mismatchError,
	readLocalHead,
};
