// Execucao sob demanda do seed de um feed ("Run now" do painel): sobe o
// arquivo novo, roda o script daquele feed e ve o resultado sem esperar o
// seed-all das 7:32/19:32.
//
// O comando e SEMPRE "feed-sync <feed> && <seedCommand>": sem o sync o seed
// leria o symlink antigo em prisma/seeds/api-calls e reportaria sucesso com o
// arquivo ANTERIOR — sucesso silencioso, exatamente o que esta feature existe
// para eliminar. O sync em modo de feed unico falha se nao houver lote.
//
// Protecoes (o seed escreve em VendorProduct de producao):
//  - uma execucao manual por vez no processo inteiro (staging tables sao
//    compartilhadas: dois seeds simultaneos truncariam a tabela um do outro);
//  - bloqueia enquanto o seed-all esta rodando (lock file do orquestrador) e o
//    server.js bloqueia o caminho inverso consultando isBusy();
//  - mesmo heap cap do seed-all (lib/seeds/childHeap.js): sem ele o filho pode
//    estourar os 2GB do container e derrubar a API junto;
//  - so feeds com seedCommand no config/feeds.js — scripts que escrevem preco
//    na loja ao vivo (WARN) ficam de fora de proposito.
//
// spawn/fs injetaveis para os testes rodarem sem processo nem disco real.

const nodeFs = require('fs');
const nodePath = require('path');
const { spawn: nodeSpawn } = require('child_process');
const { childHeapMbFor } = require('../seeds/childHeap');

const RUN_TIMEOUT_MS = Number(process.env.FEED_RUN_TIMEOUT_MS || 30 * 60 * 1000);
const KILL_GRACE_MS = Number(process.env.FEED_RUN_KILL_GRACE_MS || 10000);
const LOG_TAIL_BYTES = 16 * 1024;
// Defesa em profundidade: feed/comando vem do config/feeds.js (nunca do
// request), mas a string vai para um shell — so aceitamos nomes simples.
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/i;

function createFeedRunner({
	spawn = nodeSpawn,
	fs = nodeFs,
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

		if (!SAFE_NAME.test(feed.name) || !SAFE_NAME.test(feed.seedCommand)) {
			throw typedError('FEED_RUN_NOT_ALLOWED', `Unsafe feed or command name for ${feed.name}`);
		}

		fs.mkdirSync(logDir, { recursive: true });
		const logFile = logFileFor(feed.name);
		// Sync primeiro: garante que o symlink aponta para o lote catalogado
		// (o arquivo que a pessoa acabou de subir) antes do seed ler o disco.
		const shellCommand = `npm run feed-sync -- ${feed.name} && npm run ${feed.seedCommand}`;
		fs.writeFileSync(logFile, `=== ${new Date(now()).toISOString()} ${shellCommand} (by ${startedBy || 'unknown'}) ===\n`);
		const logStream = fs.createWriteStream(logFile, { flags: 'a' });

		const child = spawn('sh', ['-c', shellCommand], {
			cwd: rootDir,
			env: {
				...process.env,
				APP_ROLE: 'seed',
				INGEST_TRIGGER: 'manual',
				NODE_OPTIONS: `--max-old-space-size=${childHeapMbFor(feed.seedCommand)}`,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.pipe(logStream);
		child.stderr.pipe(logStream);

		const record = {
			feed: feed.name,
			command: feed.seedCommand,
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
			// Sem escalar para SIGKILL, um filho travado deixaria o slot ocupado
			// para sempre (todo Run now seguinte responderia FEED_RUN_BUSY).
			killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
			killTimer.unref?.();
		}, RUN_TIMEOUT_MS);
		// Nao segura o event loop: o timer existe so enquanto o processo vive.
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
		};

		child.on('error', (error) => finish(null, error.message));
		child.on('close', (code) => finish(code, record.error));

		return record;
	}

	// Ultimos KB do log, para o painel mostrar o que aconteceu sem baixar
	// arquivo inteiro (alguns seeds logam dezenas de MB).
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
