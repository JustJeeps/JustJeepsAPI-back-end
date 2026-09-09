// One-line diagnosis for a seed child that did not exit 0. The child is
// `npm run <cmd>`, so when the node grandchild dies on a signal npm exits with
// 128 + signal and seed-all sees a numeric code with signal null: 134 is V8
// aborting on its own heap cap, 137 is the kernel OOM killer (the container
// memory limit), which used to be reported as a bare "Exit code 137".

function describeChildExit({ code, signal, heapMb }) {
	if (code === 134 || signal === 'SIGABRT') {
		return `V8 heap OOM (exceeded --max-old-space-size=${heapMb}MB)`;
	}
	if (code === 137 || signal === 'SIGKILL') {
		return `Killed by SIGKILL (exit 137): almost always the kernel OOM killer at the container memory limit, outside the V8 heap cap of ${heapMb}MB`;
	}
	if (signal) return `Signal ${signal}`;
	return `Exit code ${code}`;
}

module.exports = { describeChildExit };
