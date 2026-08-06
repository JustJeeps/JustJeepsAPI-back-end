// Heap cap per seed child process: a deterministic failure with exit 134
// (recorded in the summary) instead of letting the kernel OOM killer pick a
// victim on the host. The droplet has 1.9GB for API + Postgres + seed; do not
// raise this without measuring.
//
// Single source for seed-all (prisma/seeds/seed-individual/seed-all.js) and
// for the panel's "Run now" (lib/feeds/feedRunner.js), since both run the SAME
// scripts and therefore need the same ceiling.

const DEFAULT_CHILD_HEAP_MB = 768;
const CHILD_HEAP_MB_BY_CMD = {
	'seed-keystone-ftp2': 1024, // the invMap of ~2.4M VCPNs is the biggest legitimate consumer
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
