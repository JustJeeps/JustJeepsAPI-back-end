// On demand execution of a feed seed (the panel's "Run now"): upload the new
// file, run the script for that feed and see the result without waiting for
// the 7:32/19:32 seed-all.
//
// The command is ALWAYS "feed-sync <feed> && <seedCommand>": without the sync
// the seed would read the old symlink in prisma/seeds/api-calls and report
// success with the PREVIOUS file, a silent success, exactly what this feature
// exists to eliminate. The sync in single feed mode fails if there is no batch.
//
// Protections (the seed writes to production VendorProduct):
//  - one manual execution at a time in the whole process (staging tables are
//    shared: two simultaneous seeds would truncate each other's table);
//  - blocks while seed-all is running (the orchestrator lock file) and
//    server.js blocks the reverse path by checking isBusy();
//  - same heap cap as seed-all (lib/seeds/childHeap.js): without it the child
//    can blow past the container's 2GB and take the API down with it;
//  - only feeds with a seedCommand in config/feeds.js, so scripts that write
//    prices to the live store (WARN) are left out on purpose.
//
// spawn/fs are injectable so the tests run without a real process or disk.

const nodeFs = require('fs');
const nodePath = require('path');
const { spawn: nodeSpawn } = require('child_process');
const { childHeapMbFor } = require('../seeds/childHeap');
const { recordScriptRun } = require('./runRecorder');

const RUN_TIMEOUT_MS = Number(process.env.FEED_RUN_TIMEOUT_MS || 30 * 60 * 1000);
const KILL_GRACE_MS = Number(process.env.FEED_RUN_KILL_GRACE_MS || 10000);
const LOG_TAIL_BYTES = 16 * 1024;
// Defense in depth: feed/command come from config/feeds.js (never from the
// request), but the string goes to a shell, so we only accept simple names.
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/i;

function createFeedRunner({
	spawn = nodeSpawn,
	fs = nodeFs,
	// Only the seeds built on lib/ingest record an IngestRun of their own. For
	// every other vendor script the panel had nothing to show and said "never"
	// even right after a run that worked, so the runner records the outcome
	// itself when the script did not.
	prisma = null,
	feedsConfig = require('../../config/feeds'),
	rootDir = nodePath.join(__dirname, '../..'),
	logDir = nodePath.join(__dirname, '../../logs'),
	seedAllLockFile = nodePath.join(__dirname, '../../prisma/seeds/logs/seed-all.lock'),
	now = () => Date.now(),
} = {}) {
	// feed -> { status, command, startedAt, finishedAt, exitCode, error, logFile, startedBy }
	const runs = new Map();
	let activeFeed = null;

	const logFileFor = (feed) => nodePath.join(logDir, `feed-run-${feed}.log`);

	// Records the outcome so the panel shows something for scripts that do not
	// record a run of their own (lib/feeds/runRecorder.js).
	async function recordRunIfSeedDidNot(feed, record) {
		if (!prisma) return;
		await recordScriptRun(prisma, {
			feed,
			command: record.command,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			status: record.status,
			error: record.error,
		});
	}

	function typedError(code, message) {
		const error = new Error(message);
		error.code = code;
		return error;
	}

	function start(feedName, { startedBy = null } = {}) {
		const feed = feedsConfig.getFeedByName(feedName);
		if (!feed) throw typedError('FEED_UNKNOWN', `Unknown feed: ${feedName}`);
		if (!feed.seedCommand) {
			throw typedError('FEED_RUN_NOT_ALLOWED', feed.seedCommandNote || `Feed ${feedName} cannot be run from the panel`);
		}
		if (activeFeed) {
			throw typedError('FEED_RUN_BUSY', `Another feed script is running (${activeFeed}). Wait for it to finish.`);
		}
		if (fs.existsSync(seedAllLockFile)) {
			throw typedError('FEED_RUN_BUSY', 'The daily vendor sync is running. Try again when it finishes.');
		}

		// A feed may need more than one script, in the order the daily sync runs
		// them (Quadratec applies prices first, then inventory).
		const commands = Array.isArray(feed.seedCommand) ? feed.seedCommand : [feed.seedCommand];
		if (!SAFE_NAME.test(feed.name) || commands.some((command) => !SAFE_NAME.test(command))) {
			throw typedError('FEED_RUN_NOT_ALLOWED', `Unsafe feed or command name for ${feed.name}`);
		}

		fs.mkdirSync(logDir, { recursive: true });
		const logFile = logFileFor(feed.name);
		// Sync first: makes sure the symlink points to the catalogued batch (the
		// file the person just uploaded) before the seed reads the disk.
		const shellCommand = [`npm run feed-sync -- ${feed.name}`, ...commands.map((command) => `npm run ${command}`)].join(' && ');
		fs.writeFileSync(logFile, `=== ${new Date(now()).toISOString()} ${shellCommand} (by ${startedBy || 'unknown'}) ===\n`);
		const logStream = fs.createWriteStream(logFile, { flags: 'a' });

		const child = spawn('sh', ['-c', shellCommand], {
			cwd: rootDir,
			env: {
				...process.env,
				APP_ROLE: 'seed',
				INGEST_TRIGGER: 'manual',
				// With several scripts chained in one shell the cap has to fit the
				// hungriest of them.
				NODE_OPTIONS: `--max-old-space-size=${Math.max(...commands.map(childHeapMbFor))}`,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.pipe(logStream);
		child.stderr.pipe(logStream);

		const record = {
			feed: feed.name,
			command: commands.join(' && '),
			status: 'running',
			startedAt: new Date(now()).toISOString(),
			finishedAt: null,
			exitCode: null,
			error: null,
			logFile,
			startedBy,
		};
		runs.set(feed.name, record);
		activeFeed = feed.name;

		let killTimer = null;
		const timer = setTimeout(() => {
			record.error = `Timed out after ${Math.round(RUN_TIMEOUT_MS / 60000)} min`;
			child.kill('SIGTERM');
			// Without escalating to SIGKILL, a stuck child would hold the slot
			// forever (every following Run now would answer FEED_RUN_BUSY).
			killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
			killTimer.unref?.();
		}, RUN_TIMEOUT_MS);
		// Does not hold the event loop: the timer only exists while the process lives.
		timer.unref?.();

		const finish = (exitCode, error) => {
			if (record.status !== 'running') return;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			record.status = exitCode === 0 && !error ? 'success' : 'failed';
			record.exitCode = exitCode;
			record.finishedAt = new Date(now()).toISOString();
			if (error) record.error = error;
			activeFeed = null;
			recordRunIfSeedDidNot(feed, record).catch((recordError) => {
				console.warn(`Could not record the run of ${feed.name}: ${recordError.message}`);
			});
		};

		child.on('error', (error) => finish(null, error.message));
		child.on('close', (code) => finish(code, record.error));

		return record;
	}

	// Last KB of the log, so the panel can show what happened without
	// downloading the whole file (some seeds log tens of MB).
	function readLogTail(logFile) {
		try {
			const { size } = fs.statSync(logFile);
			const start = Math.max(0, size - LOG_TAIL_BYTES);
			const fd = fs.openSync(logFile, 'r');
			try {
				const buffer = Buffer.alloc(size - start);
				fs.readSync(fd, buffer, 0, buffer.length, start);
				return buffer.toString('utf8');
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return '';
		}
	}

	function getStatus(feedName) {
		const record = runs.get(feedName);
		if (!record) return null;
		return {
			...record,
			durationMs: record.finishedAt ? Date.parse(record.finishedAt) - Date.parse(record.startedAt) : now() - Date.parse(record.startedAt),
			logTail: readLogTail(record.logFile),
		};
	}

	const isBusy = () => Boolean(activeFeed);

	return { start, getStatus, isBusy };
}

module.exports = { createFeedRunner };
