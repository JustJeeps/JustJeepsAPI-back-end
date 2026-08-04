const test = require('node:test');
const assert = require('node:assert');

const { validateChange } = require('../../lib/requests/transitions.js');

// Modulo puro: recebe o estado atual + patch + flag de triage e devolve
// { ok, autoStatus?, error? } — nenhum contato com o Postgres (o .env local
// aponta para producao).

const current = (overrides = {}) => ({
	status: 'New Request',
	assignee_id: null,
	...overrides,
});

test('mudanca de campos simples (priority/title) nao exige triage', () => {
	const result = validateChange({
		current: current(),
		patch: { priority: 'High' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.autoStatus, undefined);
});

test('qualquer usuario pode setar assignee (decisao de 2026-08-03)', () => {
	const result = validateChange({
		current: current(),
		patch: { assigneeId: 2 },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.autoStatus, 'Assigned');
});

test('qualquer usuario pode remover assignee', () => {
	const result = validateChange({
		current: current({ status: 'Assigned', assignee_id: 2 }),
		patch: { assigneeId: null },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('fechar chamado continua exclusivo de triage', () => {
	const result = validateChange({
		current: current({ status: 'Completed', assignee_id: 2 }),
		patch: { status: 'Closed' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'TRIAGE_ONLY');
});

test('triage atribuindo em New Request move automaticamente para Assigned', () => {
	const result = validateChange({
		current: current(),
		patch: { assigneeId: 2 },
		isTriage: true,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.autoStatus, 'Assigned');
});

test('triage atribuindo em Estimation mantem o status atual', () => {
	const result = validateChange({
		current: current({ status: 'Estimation' }),
		patch: { assigneeId: 2 },
		isTriage: true,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.autoStatus, undefined);
});

test('triage desatribuindo em New Request e permitido', () => {
	const result = validateChange({
		current: current({ assignee_id: 2 }),
		patch: { assigneeId: null },
		isTriage: true,
	});
	assert.strictEqual(result.ok, true);
});

test('mover para Assigned sem assignee (atual ou no patch) e rejeitado', () => {
	const result = validateChange({
		current: current(),
		patch: { status: 'Assigned' },
		isTriage: true,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'ASSIGNEE_REQUIRED');
});

test('mover para Assigned atribuindo no mesmo patch e permitido', () => {
	const result = validateChange({
		current: current(),
		patch: { status: 'Assigned', assigneeId: 2 },
		isTriage: true,
	});
	assert.strictEqual(result.ok, true);
});

test('mover para Assigned removendo o assignee no mesmo patch e rejeitado', () => {
	const result = validateChange({
		current: current({ status: 'Work in Progress', assignee_id: 2 }),
		patch: { status: 'Assigned', assigneeId: null },
		isTriage: true,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'ASSIGNEE_REQUIRED');
});

test('nao-triage pode mover status quando ja ha assignee', () => {
	const result = validateChange({
		current: current({ status: 'Assigned', assignee_id: 2 }),
		patch: { status: 'Work in Progress' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

for (const status of ['On Hold', 'Awaiting Client Response', 'Completed']) {
	test(`mover para ${status} sem comentario e rejeitado`, () => {
		const result = validateChange({
			current: current({ status: 'Work in Progress', assignee_id: 2 }),
			patch: { status },
			isTriage: false,
		});
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.error.code, 'COMMENT_REQUIRED');
	});

	test(`mover para ${status} com comentario e permitido`, () => {
		const result = validateChange({
			current: current({ status: 'Work in Progress', assignee_id: 2 }),
			patch: { status, comment: 'Blocked by deploy window' },
			isTriage: false,
		});
		assert.strictEqual(result.ok, true);
	});
}

test('comentario em branco nao satisfaz a exigencia', () => {
	const result = validateChange({
		current: current({ status: 'Work in Progress', assignee_id: 2 }),
		patch: { status: 'On Hold', comment: '   ' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'COMMENT_REQUIRED');
});

test('patch sem mudanca de status nao exige comentario mesmo em status bloqueado', () => {
	const result = validateChange({
		current: current({ status: 'On Hold', assignee_id: 2 }),
		patch: { priority: 'Urgent' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('repetir o proprio status atual nao exige comentario', () => {
	const result = validateChange({
		current: current({ status: 'On Hold', assignee_id: 2 }),
		patch: { status: 'On Hold' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('fechar (Closed) e exclusivo de triage', () => {
	const result = validateChange({
		current: current({ status: 'Completed', assignee_id: 2 }),
		patch: { status: 'Closed' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'TRIAGE_ONLY');
});

test('triage pode fechar', () => {
	const result = validateChange({
		current: current({ status: 'Completed', assignee_id: 2 }),
		patch: { status: 'Closed' },
		isTriage: true,
	});
	assert.strictEqual(result.ok, true);
});

test('reabrir Closed so pode ir para Assigned', () => {
	const result = validateChange({
		current: current({ status: 'Closed', assignee_id: 2 }),
		patch: { status: 'Work in Progress' },
		isTriage: true,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
});

test('reabrir Closed para Assigned mantendo o assignee anterior e permitido', () => {
	const result = validateChange({
		current: current({ status: 'Closed', assignee_id: 2 }),
		patch: { status: 'Assigned' },
		isTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('reabrir Closed sem assignee e rejeitado', () => {
	const result = validateChange({
		current: current({ status: 'Closed', assignee_id: null }),
		patch: { status: 'Assigned' },
		isTriage: true,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'ASSIGNEE_REQUIRED');
});

test('status desconhecido e rejeitado', () => {
	const result = validateChange({
		current: current(),
		patch: { status: 'Banana' },
		isTriage: true,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'INVALID_STATUS');
});

test('erro sempre traz mensagem legivel', () => {
	const result = validateChange({
		current: current(),
		patch: { status: 'Assigned' },
		isTriage: true,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(typeof result.error.message, 'string');
	assert.ok(result.error.message.length > 0);
});
