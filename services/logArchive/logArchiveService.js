// Ships each run's log output to DO Spaces, one object per run.
//
// Hard rule: this is bookkeeping, it NEVER fails the work it observes. Every
// entry point swallows its errors and returns a reason instead of throwing —
// a bucket outage must not turn a healthy Daily Vendor Sync into a red run.
//
// Reads: prisma/seeds/logs/*.log (seed-all steps) and logs/*.log (command
// crons). Both are append-only, so a run is a byte range, not a file — see
// lib/logArchive/keys.js.

const fs = require('fs');
const { PassThrough } = require('stream');

const { createFeedStore } = require('../../lib/feeds/feedStore');
const {
	DEFAULT_PREFIX,
	DEFAULT_MAX_BYTES,
	buildLogKey,
	resolveSlice,
	truncationHeader,
} = require('../../lib/logArchive/keys');

function createLogArchive({ store = null, env = process.env, logger = console } = {}) {
	// Off by default only when explicitly disabled: the point is that it is
	// there when something breaks, and nobody remembers to turn it on first.
	const enabled = env.LOG_ARCHIVE_ENABLED !== 'false';
	const prefix = env.DO_SPACES_LOGS_PREFIX || DEFAULT_PREFIX;
	const maxBytes = Number(env.LOG_ARCHIVE_MAX_BYTES || DEFAULT_MAX_BYTES);
	const bucketStore = store || createFeedStore({ env });

	const isConfigured = () => enabled && bucketStore.isConfigured();

	// Call before starting the run: where the file ends now is where this run's
	// output will begin. Missing file counts as 0 (the writer creates it).
	function currentOffset(filePath) {
		if (!filePath) return 0;
		try {
			return fs.statSync(filePath).size;
		} catch {
			return 0;
		}
	}

	async function archiveRun({ filePath, command, startedAt, status, source = 'cron', startOffset = 0 }) {
		if (!isConfigured()) return { archived: false, reason: 'not-configured' };
		if (!filePath) return { archived: false, reason: 'no-log-file' };

		try {
			const endOffset = currentOffset(filePath);
			const slice = resolveSlice({ startOffset, endOffset, maxBytes });
			if (slice.skip) return { archived: false, reason: slice.reason };

			const key = buildLogKey({ command, startedAt, status, source, prefix });

			let body = fs.createReadStream(filePath, { start: slice.start, end: slice.end });
			let contentLength = slice.bytes;

			if (slice.truncated) {
				const header = Buffer.from(truncationHeader({
					omittedBytes: slice.omittedBytes,
					command,
					startedAt,
				}), 'utf8');
				const combined = new PassThrough();
				combined.write(header);
				body.on('error', (error) => combined.destroy(error));
				body.pipe(combined);
				body = combined;
				contentLength += header.length;
			}

			await bucketStore.putStream({
				key,
				body,
				contentLength,
				contentType: 'text/plain; charset=utf-8',
			});

			return { archived: true, key, bytes: contentLength, truncated: Boolean(slice.truncated) };
		} catch (error) {
			logger.warn?.(`[log-archive] Could not archive the log of ${command}: ${error.message}`);
			return { archived: false, reason: 'upload-failed', error: error.message };
		}
	}

	// The seed-all summary is the one file that is rewritten (not appended) each
	// run, so it goes up whole, next to that run's step logs.
	async function archiveFile({ filePath, command, startedAt, status, source = 'cron', extension = 'json', contentType = 'application/json' }) {
		if (!isConfigured()) return { archived: false, reason: 'not-configured' };
		if (!filePath) return { archived: false, reason: 'no-log-file' };

		try {
			const { size } = fs.statSync(filePath);
			if (!size) return { archived: false, reason: 'empty' };

			const key = buildLogKey({ command, startedAt, status, source, prefix, extension });
			await bucketStore.putFile({ key, filePath, sizeBytes: size, contentType });
			return { archived: true, key, bytes: size };
		} catch (error) {
			logger.warn?.(`[log-archive] Could not archive ${filePath}: ${error.message}`);
			return { archived: false, reason: 'upload-failed', error: error.message };
		}
	}

	return { isConfigured, currentOffset, archiveRun, archiveFile };
}

module.exports = { createLogArchive };
