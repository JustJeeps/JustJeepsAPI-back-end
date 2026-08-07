const test = require('node:test');
const assert = require('node:assert');

const { resolveArchive } = require('../../lib/requests/archive.js');
const { canManageRequest, canRestoreRequest } = require('../../lib/requests/permissions.js');

// Modulos puros: sem banco, sem rede.

const AUTHOR = { id: 10, username: 'david' };
const OTHER = { id: 99, username: 'jacob' };

const current = (overrides = {}) => ({
	id: 1,
	status: 'Work in Progress',
	archivedAt: null,
	requester_id: AUTHOR.id,
	...overrides,
});

// --- permissoes ---------------------------------------------------------------

test('o autor pode gerenciar o proprio chamado', () => {
	assert.strictEqual(canManageRequest({ request: current(), user: AUTHOR, isTriage: false }), true);
});

test('triage pode gerenciar chamado de qualquer um', () => {
	assert.strictEqual(canManageRequest({ request: current(), user: OTHER, isTriage: true }), true);
});

test('quem nao e autor nem triage nao pode gerenciar', () => {
	assert.strictEqual(canManageRequest({ request: current(), user: OTHER, isTriage: false }), false);
});

test('restaurar e exclusivo de triage', () => {
	assert.strictEqual(canRestoreRequest({ isTriage: true }), true);
	assert.strictEqual(canRestoreRequest({ isTriage: false }), false);
});

// --- arquivamento -------------------------------------------------------------

test('o autor arquiva em qualquer status (nao exige Completed/Closed)', () => {
	const result = resolveArchive({
		current: current({ status: 'Work in Progress' }),
		patch: { archived: true },
		user: AUTHOR,
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.changed, true);
	assert.ok(result.archivedAt instanceof Date);
});

test('triage arquiva chamado de outra pessoa', () => {
	const result = resolveArchive({
		current: current(),
		patch: { archived: true },
		user: OTHER,
		isTriage: true,
	});
	assert.strictEqual(result.ok, true);
	assert.ok(result.archivedAt instanceof Date);
});

test('quem nao e autor nem triage e barrado', () => {
	const result = resolveArchive({
		current: current(),
		patch: { archived: true },
		user: OTHER,
		isTriage: false,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'ARCHIVE_FORBIDDEN');
});

test('desarquivar segue a mesma permissao e zera a data', () => {
	const result = resolveArchive({
		current: current({ archivedAt: new Date() }),
		patch: { archived: false },
		user: AUTHOR,
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.changed, true);
	assert.strictEqual(result.archivedAt, null);
});

test('mudar o status NAO desarquiva (arquivar e escolha explicita)', () => {
	const result = resolveArchive({
		current: current({ status: 'Completed', archivedAt: new Date() }),
		patch: { status: 'Work in Progress' },
		user: AUTHOR,
		isTriage: false,
	});
	assert.strictEqual(result.changed, false);
});

test('pedir o estado que ja vale nao muda nada', () => {
	const jaArquivado = resolveArchive({
		current: current({ archivedAt: new Date() }),
		patch: { archived: true },
		user: AUTHOR,
		isTriage: false,
	});
	assert.strictEqual(jaArquivado.changed, false);

	const semArchived = resolveArchive({
		current: current(),
		patch: { priority: 'High' },
		user: AUTHOR,
		isTriage: false,
	});
	assert.strictEqual(semArchived.changed, false);
});
