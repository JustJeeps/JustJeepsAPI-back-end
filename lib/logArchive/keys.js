// Pure rules for the run log archive (DO Spaces). No fs, no network: the
// service in services/logArchive/logArchiveService.js does the I/O.
//
// Why an archive at all: the log files under prisma/seeds/logs and logs/ are
// opened in append mode and never rotate, so they grow without bound on the
// droplet, and anything not on a volume dies with the container on deploy. On
// 2026-08-07 the Keystone fetch error from the previous day was only
// recoverable because that directory happened to survive; the container stdout
// was already gone. One object per run in Spaces fixes both.

const DEFAULT_PREFIX = 'logs';

// A run's slice is what it appended, not the whole file. 20MB is far above a
// normal run (the biggest daily log is a few MB) and still small enough that a
// runaway loop cannot fill the bucket.
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const pad = (value) => String(value).padStart(2, '0');

// 20260807T054512Z — sorts lexicographically, same shape feedStore.buildKey
// already uses for artifacts.
function formatStamp(date) {
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T`
		+ `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// Command names come from config/cron-jobs.js, but a key is a path: a stray
// slash or ".." would silently write outside the prefix and break any lifecycle
// rule set on it.
function slugify(value, fallback) {
	const cleaned = String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/\.{2,}/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '');
	return cleaned || fallback;
}

// <prefix>/<source>/<command>/<YYYY>/<MM>/<DD>/<stamp>-<status>.log
//
// The date folders are what make retention a one-liner in the Spaces panel and
// keep a single day's runs together when reading by hand.
function buildLogKey({ command, startedAt, status, source = 'cron', prefix = DEFAULT_PREFIX, extension = 'log' }) {
	const date = startedAt instanceof Date ? startedAt : new Date(startedAt);
	if (Number.isNaN(date.getTime())) throw new TypeError('buildLogKey needs a valid startedAt');

	const cleanPrefix = String(prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '') || DEFAULT_PREFIX;
	const stamp = formatStamp(date);

	return [
		cleanPrefix,
		slugify(source, 'unknown'),
		slugify(command, 'unknown'),
		date.getUTCFullYear(),
		pad(date.getUTCMonth() + 1),
		pad(date.getUTCDate()),
		`${stamp}-${slugify(status, 'unknown')}.${slugify(extension, 'log')}`,
	].join('/');
}

// Which byte range of the file this run wrote. The file is append-only, so the
// size before the run is where the run's output starts.
//
// When a run writes more than maxBytes we keep the TAIL: the failure and its
// stack are at the end, the top is the same startup banner every time.
function resolveSlice({ startOffset = 0, endOffset = 0, maxBytes = DEFAULT_MAX_BYTES }) {
	const start = Math.max(0, Number(startOffset) || 0);
	const end = Math.max(0, Number(endOffset) || 0);

	// Someone truncated or replaced the file mid-run (log rotation by hand, a
	// fresh container): the offset no longer means anything, take the file.
	const from = end < start ? 0 : start;
	const total = end - from;

	if (total <= 0) return { skip: true, reason: 'empty', bytes: 0 };
	if (total <= maxBytes) return { skip: false, start: from, end: end - 1, bytes: total, truncated: false, omittedBytes: 0 };

	const tailStart = end - maxBytes;
	return {
		skip: false,
		start: tailStart,
		end: end - 1,
		bytes: maxBytes,
		truncated: true,
		omittedBytes: tailStart - from,
	};
}

// Goes at the top of a truncated object so whoever downloads it is not misled
// into thinking the run started there.
function truncationHeader({ omittedBytes, command, startedAt }) {
	const when = startedAt instanceof Date ? startedAt.toISOString() : String(startedAt);
	return `[log-archive] Run of "${command}" at ${when}: the first ${omittedBytes} bytes were omitted; this is the tail of the output.\n`;
}

module.exports = {
	DEFAULT_PREFIX,
	DEFAULT_MAX_BYTES,
	buildLogKey,
	resolveSlice,
	truncationHeader,
	formatStamp,
	slugify,
};
