const test = require('node:test');
const assert = require('node:assert');

const { canViewRequest } = require('../../lib/sectors/visibility.js');

// Visibilidade por membership (decisao de 2026-08-12, substitui o "todos veem
// tudo"): um chamado e visivel para membros do setor dele, para quem o abriu
// (acompanha o proprio chamado em setor alheio), para quem esta atribuido e
// para triage. Modulo puro — o WHERE do service e o espelho disto.

const request = (overrides = {}) => ({
	id: 1,
	sector_id: 3,
	requester_id: 99,
	assignees: [],
	...overrides,
});

test('triage ve qualquer chamado', () => {
	assert.strictEqual(
		canViewRequest({ request: request(), userId: 50, memberSectorIds: [], isTriage: true }),
		true
	);
});

test('membro do setor ve os chamados do setor', () => {
	assert.strictEqual(
		canViewRequest({ request: request(), userId: 50, memberSectorIds: [3], isTriage: false }),
		true
	);
});

test('nao-membro nao ve chamado alheio do setor', () => {
	assert.strictEqual(
		canViewRequest({ request: request(), userId: 50, memberSectorIds: [1], isTriage: false }),
		false
	);
});

test('quem abriu o chamado sempre ve, mesmo fora do setor', () => {
	assert.strictEqual(
		canViewRequest({ request: request({ requester_id: 50 }), userId: 50, memberSectorIds: [], isTriage: false }),
		true
	);
});

test('assignee sempre ve, mesmo fora do setor', () => {
	const withAssignee = request({ assignees: [{ user_id: 50 }] });
	assert.strictEqual(
		canViewRequest({ request: withAssignee, userId: 50, memberSectorIds: [], isTriage: false }),
		true
	);
});

test('assignee via assignee_id (linha primaria) tambem conta', () => {
	const primary = request({ assignee_id: 50, assignees: undefined });
	assert.strictEqual(
		canViewRequest({ request: primary, userId: 50, memberSectorIds: [], isTriage: false }),
		true
	);
});

test('sem usuario nao ve nada', () => {
	assert.strictEqual(
		canViewRequest({ request: request(), userId: null, memberSectorIds: [], isTriage: false }),
		false
	);
});
