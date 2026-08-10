// Decides which command cron may run when only one can run at a time.
//
// Why it exists: the previous rule was "if something else is running, DROP this
// run". For a job that fires every five minutes that is harmless, it catches up
// on the next tick. For a job that fires once a day it means the run is lost
// until tomorrow, and if the collision is structural it is lost every day. That
// is what happened to the Magento attribute sync: it is scheduled at 02:20, the
// orders delta runs every five minutes so it also fires at :20, the orders job
// wins the lock, and the Magento job was dropped every night from 2026-07-20 to
// 2026-08-10 without anyone noticing. Three weeks of vendor costs never reached
// the store.
//
// So a blocked run is now DEFERRED instead of dropped: it waits for the lock and
// starts as soon as it frees. One pending slot per command, so a job that keeps
// firing while blocked does not pile up a queue of identical runs (the newest
// request replaces the older one; for a watermark-based job like the orders
// delta, running once after the block catches everything up anyway).
//
// A deferral is not free: a run that waited hours may no longer be worth doing,
// so anything older than maxDeferMs is dropped for real, and dropped runs are
// reported rather than swallowed.
//
// Pure and injectable (no timers, no logging of its own): the caller supplies
// the clock and decides what to do with the outcome.

const DEFAULT_MAX_DEFER_MS = Number(process.env.CRON_DEFER_MAX_MS || 4 * 60 * 60 * 1000);

function createCommandGate({ maxDeferMs = DEFAULT_MAX_DEFER_MS, now = () => Date.now() } = {}) {
	let active = null;
	// command -> { command, jobName, requestedAt }
	const pending = new Map();

	// Can this job start? 'run' takes the lock; 'deferred' means it waits for
	// release() to hand it back.
	function request({ command, jobName = command }) {
		if (!active) {
			active = { command, jobName, startedAt: now() };
			return { decision: 'run' };
		}

		if (active.command === command) {
			// The job is still running from a previous tick. Deferring here would
			// queue a run of something already in progress.
			return { decision: 'skipped', reason: 'previous run still in progress', blockedBy: active };
		}

		const alreadyPending = pending.get(command);
		pending.set(command, { command, jobName, requestedAt: alreadyPending?.requestedAt ?? now() });
		return { decision: 'deferred', blockedBy: active };
	}

	// Releases the lock and returns what should run next, plus whatever waited
	// too long to still be worth running.
	function release() {
		active = null;

		const expired = [];
		for (const [command, job] of [...pending]) {
			if (now() - job.requestedAt > maxDeferMs) {
				pending.delete(command);
				expired.push({ ...job, waitedMs: now() - job.requestedAt });
			}
		}

		// Oldest request first: a daily job blocked at 02:20 goes before a job
		// that was blocked seconds ago.
		const next = [...pending.values()].sort((a, b) => a.requestedAt - b.requestedAt)[0] || null;
		if (next) {
			pending.delete(next.command);
			active = { command: next.command, jobName: next.jobName, startedAt: now() };
		}

		return { next: next ? { ...next, waitedMs: now() - next.requestedAt } : null, expired };
	}

	// A run blocked by something outside this gate (a manual feed run from the
	// panel): remember it so it still happens once the way is clear.
	function defer({ command, jobName = command }) {
		const alreadyPending = pending.get(command);
		pending.set(command, { command, jobName, requestedAt: alreadyPending?.requestedAt ?? now() });
	}

	const getActive = () => (active ? { ...active } : null);
	const pendingCommands = () => [...pending.keys()];

	return { request, release, defer, getActive, pendingCommands };
}

module.exports = { createCommandGate, DEFAULT_MAX_DEFER_MS };
