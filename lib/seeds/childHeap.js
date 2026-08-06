// Heap cap por processo-filho de seed: falha deterministica com exit 134
// (registrada no summary) em vez de deixar o OOM-killer do kernel escolher uma
// vitima no host. O droplet tem 1.9GB para API + Postgres + seed; nao subir sem
// medir.
//
// Fonte unica para o seed-all (prisma/seeds/seed-individual/seed-all.js) e para
// o "Run now" do painel (lib/feeds/feedRunner.js) — os dois rodam os MESMOS
// scripts, entao precisam do mesmo teto.

const DEFAULT_CHILD_HEAP_MB = 768;
const CHILD_HEAP_MB_BY_CMD = {
	'seed-keystone-ftp2': 1024, // invMap de ~2.4M VCPNs e o maior consumidor legitimo
	'seed-keystone-ftp-codes': 512, // pos-streaming; funciona como teste de regressao
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
