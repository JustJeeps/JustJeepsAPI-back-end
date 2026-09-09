const test = require('node:test');
const assert = require('node:assert');

const { describeChildExit } = require('../../../lib/seeds/exitStatus');

test('exit 134 is the V8 heap cap, named with the cap that was in force', () => {
	assert.strictEqual(
		describeChildExit({ code: 134, signal: null, heapMb: 512 }),
		'V8 heap OOM (exceeded --max-old-space-size=512MB)'
	);
	assert.match(describeChildExit({ code: null, signal: 'SIGABRT', heapMb: 768 }), /768MB/);
});

test('exit 137 is named as a kernel kill, not left as a bare number', () => {
	// npm propagates 128+9 when the node grandchild is SIGKILLed by the OOM
	// killer, so seed-all only ever sees code 137 with signal null.
	const text = describeChildExit({ code: 137, signal: null, heapMb: 768 });
	assert.match(text, /SIGKILL/);
	assert.match(text, /OOM/);
	assert.match(text, /memory/i);
	assert.match(describeChildExit({ code: null, signal: 'SIGKILL', heapMb: 768 }), /SIGKILL/);
});

test('other outcomes keep the plain label', () => {
	assert.strictEqual(describeChildExit({ code: 1, signal: null, heapMb: 768 }), 'Exit code 1');
	assert.strictEqual(describeChildExit({ code: null, signal: 'SIGTERM', heapMb: 768 }), 'Signal SIGTERM');
});
