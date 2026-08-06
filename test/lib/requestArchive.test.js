const test = require('node:test');
const assert = require('node:assert');

const { resolveArchive } = require('../../lib/requests/archive.js');

// Modulo puro: sem banco, sem rede.

const current = (overrides = {}) => ({
	id: 1,
	status: 'Completed',
	archivedAt: null,
	...overrides,
});

test('arquivar um chamado concluido e permitido', () => {
	const result = resolveArchive({
		current: current(),
		patch: { archived: true },
		effectiveStatus: 'Completed',
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.changed, true);
	assert.ok(result.archivedAt instanceof Date);
});

test('arquivar um chamado em andamento e rejeitado', () => {
	const result = resolveArchive({
		current: current({ status: 'Work in Progress' }),
		patch: { archived: true },
		effectiveStatus: 'Work in Progress',
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'ARCHIVE_ONLY_DONE');
});

test('arquivar junto com a transicao para Completed usa o status efetivo', () => {
	const result = resolveArchive({
		current: current({ status: 'Work in Progress' }),
		patch: { archived: true, status: 'Completed' },
		effectiveStatus: 'Completed',
	});
	assert.strictEqual(result.ok, true);
	assert.ok(result.archivedAt instanceof Date);
});

test('desarquivar e sempre permitido', () => {
	const result = resolveArchive({
		current: current({ archivedAt: new Date() }),
		patch: { archived: false },
		effectiveStatus: 'Completed',
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.changed, true);
	assert.strictEqual(result.archivedAt, null);
});

test('reabrir um chamado arquivado desarquiva junto (senao ficaria invisivel)', () => {
	const result = resolveArchive({
		current: current({ status: 'Completed', archivedAt: new Date() }),
		patch: { status: 'Work in Progress' },
		effectiveStatus: 'Work in Progress',
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.changed, true);
	assert.strictEqual(result.archivedAt, null);
	assert.strictEqual(result.unarchivedByReopen, true);
});

test('mover entre status concluidos (Completed -> Closed) mantem arquivado', () => {
	const result = resolveArchive({
		current: current({ status: 'Completed', archivedAt: new Date() }),
		patch: { status: 'Closed' },
		effectiveStatus: 'Closed',
	});
	assert.strictEqual(result.changed, false);
});

test('patch que nao toca em status nem em archived nao mexe no arquivamento', () => {
	const result = resolveArchive({
		current: current({ archivedAt: new Date() }),
		patch: { priority: 'High' },
		effectiveStatus: 'Completed',
	});
	assert.strictEqual(result.changed, false);
});
