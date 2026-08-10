const test = require('node:test');
const assert = require('node:assert');

const { createCommandGate } = require('../../../lib/cron/commandGate');

// Clock the tests drive by hand, so "waited four hours" costs no time.
function makeGate({ maxDeferMs = 4 * 60 * 60 * 1000 } = {}) {
	let clock = 0;
	const gate = createCommandGate({ maxDeferMs, now: () => clock });
	return { gate, advance: (ms) => { clock += ms; }, at: () => clock };
}

test('a free gate lets the job run', () => {
	const { gate } = makeGate();
	assert.strictEqual(gate.request({ command: 'seed-orders-delta' }).decision, 'run');
});

test('a blocked job waits instead of being thrown away', () => {
	// This is the whole point. The Magento attribute sync is scheduled at 02:20
	// and the orders delta runs every five minutes, so it also fires at :20 and
	// takes the lock first. Dropping the Magento run there lost it until the
	// next day, every day, for three weeks.
	const { gate } = makeGate();

	gate.request({ command: 'seed-orders-delta' });
	const blocked = gate.request({ command: 'magento-attributes-daily' });

	assert.strictEqual(blocked.decision, 'deferred');
	assert.strictEqual(blocked.blockedBy.command, 'seed-orders-delta');
	assert.deepStrictEqual(gate.pendingCommands(), ['magento-attributes-daily']);
});

test('the deferred job starts as soon as the lock frees', () => {
	const { gate, advance } = makeGate();

	gate.request({ command: 'seed-orders-delta' });
	gate.request({ command: 'magento-attributes-daily', jobName: 'Magento Attributes Daily Sync' });
	advance(3000);

	const { next, expired } = gate.release();

	assert.strictEqual(next.command, 'magento-attributes-daily');
	assert.strictEqual(next.jobName, 'Magento Attributes Daily Sync');
	assert.strictEqual(next.waitedMs, 3000);
	assert.deepStrictEqual(expired, []);
	assert.strictEqual(gate.getActive().command, 'magento-attributes-daily', 'it holds the lock now');
});

test('a job that keeps firing while blocked runs once, not once per tick', () => {
	// The orders delta fires every five minutes. During a twenty minute Keystone
	// fetch that is four ticks, and it is watermark based, so one run afterwards
	// catches everything up.
	const { gate, advance } = makeGate();

	gate.request({ command: 'feed-fetch-keystone' });
	for (let tick = 0; tick < 4; tick += 1) {
		advance(5 * 60 * 1000);
		gate.request({ command: 'seed-orders-delta' });
	}

	assert.deepStrictEqual(gate.pendingCommands(), ['seed-orders-delta']);
	const { next } = gate.release();
	assert.strictEqual(next.command, 'seed-orders-delta');
	assert.strictEqual(gate.release().next, null, 'nothing left queued');
});

test('the job that waited longest goes first', () => {
	const { gate, advance } = makeGate();

	gate.request({ command: 'seed-all' });
	gate.request({ command: 'magento-attributes-daily' });
	advance(60_000);
	gate.request({ command: 'seed-orders-delta' });

	assert.strictEqual(gate.release().next.command, 'magento-attributes-daily');
	assert.strictEqual(gate.release().next.command, 'seed-orders-delta');
});

test('a run that waited too long is dropped, and says so', () => {
	// Deferring is not the same as deferring forever: a run held up for hours
	// may no longer be worth doing, and the caller has to be able to report it.
	const { gate, advance } = makeGate({ maxDeferMs: 60 * 60 * 1000 });

	gate.request({ command: 'seed-all' });
	gate.request({ command: 'magento-attributes-daily' });
	advance(2 * 60 * 60 * 1000);

	const { next, expired } = gate.release();

	assert.strictEqual(next, null);
	assert.strictEqual(expired.length, 1);
	assert.strictEqual(expired[0].command, 'magento-attributes-daily');
	assert.strictEqual(expired[0].waitedMs, 2 * 60 * 60 * 1000);
});

test('the same job firing on top of itself is skipped, not queued', () => {
	// Queueing here would mean scheduling a run of something already running.
	const { gate } = makeGate();

	gate.request({ command: 'seed-all' });
	const again = gate.request({ command: 'seed-all' });

	assert.strictEqual(again.decision, 'skipped');
	assert.match(again.reason, /still in progress/);
	assert.deepStrictEqual(gate.pendingCommands(), []);
});

test('waiting is measured from the FIRST time the job was blocked', () => {
	// Otherwise a job that keeps retrying resets its own clock and never expires.
	const { gate, advance } = makeGate({ maxDeferMs: 10 * 60 * 1000 });

	gate.request({ command: 'seed-all' });
	gate.request({ command: 'seed-orders-delta' });
	advance(6 * 60 * 1000);
	gate.request({ command: 'seed-orders-delta' });
	advance(6 * 60 * 1000);

	const { next, expired } = gate.release();
	assert.strictEqual(next, null);
	assert.strictEqual(expired[0].waitedMs, 12 * 60 * 1000);
});

test('a job blocked by something outside the gate is remembered too', () => {
	// A manual feed run from the panel blocks the crons, and that used to drop
	// them the same way.
	const { gate } = makeGate();

	gate.defer({ command: 'magento-attributes-daily' });
	assert.deepStrictEqual(gate.pendingCommands(), ['magento-attributes-daily']);

	const { next } = gate.release();
	assert.strictEqual(next.command, 'magento-attributes-daily');
});
