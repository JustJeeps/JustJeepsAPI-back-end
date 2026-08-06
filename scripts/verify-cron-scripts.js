#!/usr/bin/env node
/**
 * Checks consistency between the cron definitions (config/cron-jobs.js), the
 * npm scripts (package.json), the target files on disk and config/deploy.yml.
 *
 * Catches the regression class from commit 81047cf: a revert/merge that removes
 * a scheduled npm script would only start failing in production, on every cron
 * trigger. Run it locally with `npm run verify-cron` (it is also `npm test`);
 * CI runs it on every push/PR.
 *
 * Exits with a non-zero code listing each violation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Also validates the jobs turned off by env: drift in a disabled job becomes a
// silent failure on the day someone re-enables it.
const { getCronJobDefinitions, getReportCronJobDefinitions } = require('../config/cron-jobs');
const cron = require('node-cron');
const packageJson = require('../package.json');

const scripts = packageJson.scripts || {};
const violations = [];

function addViolation(message) {
	violations.push(message);
}

/** Extracts the file paths invoked via "node <path>" inside an npm script. */
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
// 1) Command crons: does the npm script exist? valid schedule? .js file exists?
// ---------------------------------------------------------------------------
const commandDefinitions = getCronJobDefinitions({ includeDisabled: true });

for (const definition of commandDefinitions) {
	const label = `${definition.jobName} (command: ${definition.command})`;

	if (!Object.prototype.hasOwnProperty.call(scripts, definition.command)) {
		addViolation(`${label}: npm script "${definition.command}" does not exist in package.json`);
	} else {
		for (const scriptPath of extractNodeScriptPaths(scripts[definition.command])) {
			if (!fs.existsSync(path.resolve(ROOT, scriptPath))) {
				addViolation(`${label}: file "${scriptPath}" referenced by the npm script does not exist`);
			}
		}
	}

	if (!cron.validate(definition.schedule)) {
		addViolation(`${label}: invalid schedule "${definition.schedule}"`);
	}
}

// ---------------------------------------------------------------------------
// 1b) Feeds: the "Run now" button seedCommand also points to an npm script
// ---------------------------------------------------------------------------
const { getFeedDefinitions } = require('../config/feeds');

for (const feed of getFeedDefinitions()) {
	if (!feed.seedCommand) continue;
	const label = `Feed ${feed.name} (seedCommand: ${feed.seedCommand})`;

	if (!Object.prototype.hasOwnProperty.call(scripts, feed.seedCommand)) {
		addViolation(`${label}: npm script "${feed.seedCommand}" does not exist in package.json`);
	} else {
		for (const scriptPath of extractNodeScriptPaths(scripts[feed.seedCommand])) {
			if (!fs.existsSync(path.resolve(ROOT, scriptPath))) {
				addViolation(`${label}: file "${scriptPath}" referenced by the npm script does not exist`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 2) Report crons (in-process): schedule validity only (they use no npm scripts)
// ---------------------------------------------------------------------------
for (const definition of getReportCronJobDefinitions({ includeDisabled: true })) {
	if (!cron.validate(definition.schedule)) {
		addViolation(`${definition.jobName} (report): invalid schedule "${definition.schedule}"`);
	}
}

// ---------------------------------------------------------------------------
// 3) config/deploy.yml: valid CRON_* schedules and an existing CRON_TEST_COMMAND
//    (regex parsing: the env.clear block is flat, which avoids a YAML dependency)
// ---------------------------------------------------------------------------
const deployYmlPath = path.resolve(ROOT, 'config/deploy.yml');
if (fs.existsSync(deployYmlPath)) {
	const deployYml = fs.readFileSync(deployYmlPath, 'utf8');

	for (const match of deployYml.matchAll(/^\s+(CRON_[A-Z0-9_]*SCHEDULE):\s*"?([^"\n#]+?)"?\s*$/gm)) {
		const [, key, value] = match;
		if (!cron.validate(value.trim())) {
			addViolation(`deploy.yml: ${key} has an invalid schedule "${value.trim()}"`);
		}
	}

	const testCommandMatch = deployYml.match(/^\s+CRON_TEST_COMMAND:\s*"?([^"\n#]+?)"?\s*$/m);
	if (testCommandMatch) {
		const testCommand = testCommandMatch[1].trim();
		if (!Object.prototype.hasOwnProperty.call(scripts, testCommand)) {
			addViolation(`deploy.yml: CRON_TEST_COMMAND "${testCommand}" does not exist in package.json scripts`);
		}
	}
} else {
	addViolation('config/deploy.yml not found');
}

// ---------------------------------------------------------------------------
// 4) package.json: prisma.schema block present (a regression that already
//    happened: there are two schema.prisma in the repo and migrate deploy runs
//    without --schema)
// ---------------------------------------------------------------------------
if (packageJson.prisma?.schema !== 'prisma/schema.prisma') {
	addViolation('package.json: "prisma": {"schema": "prisma/schema.prisma"} block missing or incorrect');
}

// ---------------------------------------------------------------------------
// 5) No hardcoded e-mail in runtime code: recipients live ONLY in env
//    (.env.production). Local lists have already redirected a recipient without
//    review twice (May 2026 axiom-monitors, Jul 2026 .kamal/secrets). Any new
//    legitimate use goes explicitly into the EMAIL_ALLOWLIST below.
// ---------------------------------------------------------------------------
const EMAIL_LITERAL_PATTERN = /['"`]([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})['"`]/g;
const EMAIL_SCAN_TARGETS = ['server.js', 'utils', 'scripts'];
const EMAIL_ALLOWLIST = new Set([
	// 'relative/path.js:email' entries go here; empty today, on purpose
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
				addViolation(`${relative}: hardcoded e-mail "${literal}", recipients must come from env (.env.production)`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
if (violations.length > 0) {
	console.error(`❌ verify-cron: ${violations.length} problem(s) found:\n`);
	for (const violation of violations) {
		console.error(`  - ${violation}`);
	}
	process.exit(1);
}

console.log(`✅ verify-cron: ${commandDefinitions.length} command cron(s) + report crons validated with no problems.`);
