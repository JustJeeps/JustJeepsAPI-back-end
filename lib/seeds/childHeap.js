// Heap cap per seed child process: a deterministic failure with exit 134
// (recorded in the summary) instead of letting the kernel OOM killer pick a
// victim. The container is capped at 2GB (config/deploy.yml) and the API
// server, the seed-all parent and the child all live inside it; Postgres is a
// managed cluster off the droplet. Do not raise this without measuring.
//
// The cap bounds the V8 heap only: Buffers and other external memory are not
// counted, which is how a child with a 768MB cap reached 1.7GB of RSS and was
// SIGKILLed on 2026-09-09 (a corrupted CSV made csv-parser buffer the file).
//
// Single source for seed-all (prisma/seeds/seed-individual/seed-all.js) and
// for the panel's "Run now" (lib/feeds/feedRunner.js), since both run the SAME
// scripts and therefore need the same ceiling.

const DEFAULT_CHILD_HEAP_MB = 768;
const CHILD_HEAP_MB_BY_CMD = {
	'seed-keystone-ftp2': 1024, // headroom kept from the pre-staging invMap days; the pipeline is O(batch) now
	'seed-keystone-ftp-codes': 512, // post-streaming; works as a regression test
};

function childHeapMbFor(cmd) {
	const perCmdEnv = Number(process.env[`SEED_CHILD_MAX_OLD_SPACE_${String(cmd).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`]);
	if (Number.isFinite(perCmdEnv) && perCmdEnv > 0) return perCmdEnv;
	if (CHILD_HEAP_MB_BY_CMD[cmd]) return CHILD_HEAP_MB_BY_CMD[cmd];
	const globalEnv = Number(process.env.SEED_CHILD_MAX_OLD_SPACE);
	if (Number.isFinite(globalEnv) && globalEnv > 0) return globalEnv;
	return DEFAULT_CHILD_HEAP_MB;
}

module.exports = { childHeapMbFor, DEFAULT_CHILD_HEAP_MB, CHILD_HEAP_MB_BY_CMD };
