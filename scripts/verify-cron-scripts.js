#!/usr/bin/env node
/**
 * Verifica coerencia entre as definicoes de cron (config/cron-jobs.js), os
 * npm scripts (package.json), os arquivos-alvo no disco e o config/deploy.yml.
 *
 * Pega a classe de regressao do commit 81047cf: um revert/merge que remove um
 * npm script agendado passaria a falhar so em producao, a cada disparo do
 * cron. Rode localmente com `npm run verify-cron` (tambem e o `npm test`) —
 * o CI executa em todo push/PR.
 *
 * Sai com codigo != 0 listando cada violacao.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Valida tambem os jobs desligados por env: drift em job desabilitado vira
// falha silenciosa no dia em que alguem reabilitar.
const { getCronJobDefinitions, getReportCronJobDefinitions } = require('../config/cron-jobs');
const cron = require('node-cron');
const packageJson = require('../package.json');

const scripts = packageJson.scripts || {};
const violations = [];

function addViolation(message) {
	violations.push(message);
}

/** Extrai os caminhos de arquivos invocados via "node <path>" num npm script. */
function extractNodeScriptPaths(scriptText) {
	const paths = [];
	for (const segment of String(scriptText).split('&&')) {
		const trimmed = segment.trim();
		const quoted = trimmed.match(/^node\s+"([^"]+)"/);
		const bare = trimmed.match(/^node\s+([^\s"]+)/);
		if (quoted) paths.push(quoted[1]);
		else if (bare) paths.push(bare[1]);
	}
	return paths;
}

// ---------------------------------------------------------------------------
// 1) Command crons: npm script existe? schedule valido? arquivo .js existe?
// ---------------------------------------------------------------------------
const commandDefinitions = getCronJobDefinitions({ includeDisabled: true });

for (const definition of commandDefinitions) {
	const label = `${definition.jobName} (command: ${definition.command})`;

	if (!Object.prototype.hasOwnProperty.call(scripts, definition.command)) {
		addViolation(`${label}: npm script "${definition.command}" nao existe em package.json`);
	} else {
		for (const scriptPath of extractNodeScriptPaths(scripts[definition.command])) {
			if (!fs.existsSync(path.resolve(ROOT, scriptPath))) {
				addViolation(`${label}: arquivo "${scriptPath}" referenciado pelo npm script nao existe`);
			}
		}
	}

	if (!cron.validate(definition.schedule)) {
		addViolation(`${label}: schedule invalido "${definition.schedule}"`);
	}
}

// ---------------------------------------------------------------------------
// 2) Report crons (in-process): apenas schedule valido (nao usam npm scripts)
// ---------------------------------------------------------------------------
for (const definition of getReportCronJobDefinitions({ includeDisabled: true })) {
	if (!cron.validate(definition.schedule)) {
		addViolation(`${definition.jobName} (report): schedule invalido "${definition.schedule}"`);
	}
}

// ---------------------------------------------------------------------------
// 3) config/deploy.yml: schedules CRON_* validos e CRON_TEST_COMMAND existente
//    (parse por regex — o bloco env.clear e plano; evita dependencia de YAML)
// ---------------------------------------------------------------------------
const deployYmlPath = path.resolve(ROOT, 'config/deploy.yml');
if (fs.existsSync(deployYmlPath)) {
	const deployYml = fs.readFileSync(deployYmlPath, 'utf8');

	for (const match of deployYml.matchAll(/^\s+(CRON_[A-Z0-9_]*SCHEDULE):\s*"?([^"\n#]+?)"?\s*$/gm)) {
		const [, key, value] = match;
		if (!cron.validate(value.trim())) {
			addViolation(`deploy.yml: ${key} tem schedule invalido "${value.trim()}"`);
		}
	}

	const testCommandMatch = deployYml.match(/^\s+CRON_TEST_COMMAND:\s*"?([^"\n#]+?)"?\s*$/m);
	if (testCommandMatch) {
		const testCommand = testCommandMatch[1].trim();
		if (!Object.prototype.hasOwnProperty.call(scripts, testCommand)) {
			addViolation(`deploy.yml: CRON_TEST_COMMAND "${testCommand}" nao existe em package.json scripts`);
		}
	}
} else {
	addViolation('config/deploy.yml nao encontrado');
}

// ---------------------------------------------------------------------------
// 4) package.json: bloco prisma.schema presente (regressao ja ocorrida — ha
//    dois schema.prisma no repo e o migrate deploy roda sem --schema)
// ---------------------------------------------------------------------------
if (packageJson.prisma?.schema !== 'prisma/schema.prisma') {
	addViolation('package.json: bloco "prisma": {"schema": "prisma/schema.prisma"} ausente ou incorreto');
}

// ---------------------------------------------------------------------------
// 5) Nenhum e-mail hardcoded em codigo de runtime: destinatarios vivem SO em
//    env (.env.production). Listas locais ja desviaram destinatario sem review
//    duas vezes (mai/2026 axiom-monitors, jul/2026 .kamal/secrets). Uso
//    legitimo novo entra explicitamente no EMAIL_ALLOWLIST abaixo.
// ---------------------------------------------------------------------------
const EMAIL_LITERAL_PATTERN = /['"`]([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})['"`]/g;
const EMAIL_SCAN_TARGETS = ['server.js', 'utils', 'scripts'];
const EMAIL_ALLOWLIST = new Set([
	// 'caminho/relativo.js:email' — vazio hoje, de proposito
]);

function collectJsFiles(target) {
	const absolute = path.resolve(ROOT, target);
	if (!fs.existsSync(absolute)) return [];
	if (fs.statSync(absolute).isFile()) return [absolute];
	const files = [];
	for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		const entryPath = path.join(absolute, entry.name);
		if (entry.isDirectory()) files.push(...collectJsFiles(path.relative(ROOT, entryPath)));
		else if (entry.name.endsWith('.js')) files.push(entryPath);
	}
	return files;
}

for (const target of EMAIL_SCAN_TARGETS) {
	for (const filePath of collectJsFiles(target)) {
		const relative = path.relative(ROOT, filePath);
		const content = fs.readFileSync(filePath, 'utf8');
		for (const match of content.matchAll(EMAIL_LITERAL_PATTERN)) {
			const literal = match[1];
			if (!EMAIL_ALLOWLIST.has(`${relative}:${literal}`)) {
				addViolation(`${relative}: e-mail hardcoded "${literal}" — destinatarios devem vir de env (.env.production)`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------
if (violations.length > 0) {
	console.error(`❌ verify-cron: ${violations.length} problema(s) encontrado(s):\n`);
	for (const violation of violations) {
		console.error(`  - ${violation}`);
	}
	process.exit(1);
}

console.log(`✅ verify-cron: ${commandDefinitions.length} command cron(s) + report crons validados sem problemas.`);
