const test = require('node:test');
const assert = require('node:assert');

const { validateMemberChange } = require('../../lib/sectors/membership.js');

// Modulo puro: guard de orfandade (padrao do research Trello/ClickUp — os dois
// produtos sofrem quando o unico admin de uma area sai). Regra: nenhuma
// mudanca pode deixar o setor sem admin; triage global pode fazer bypass
// (o setor vira triage-managed) e o bypass volta sinalizado para audit.

const members = (list) => list.map(([userId, role]) => ({ user_id: userId, role }));

test('adicionar membro novo e sempre permitido', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin']]),
		change: { userId: 2, role: 'member' },
		actorIsTriage: false,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.bypassed, undefined);
});

test('promover membro a admin e permitido', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin'], [2, 'member']]),
		change: { userId: 2, role: 'admin' },
		actorIsTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('rebaixar um admin quando existe outro e permitido', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin'], [2, 'admin']]),
		change: { userId: 2, role: 'member' },
		actorIsTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('rebaixar o ULTIMO admin e rejeitado com LAST_ADMIN', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin'], [2, 'member']]),
		change: { userId: 1, role: 'member' },
		actorIsTriage: false,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'LAST_ADMIN');
	assert.ok(result.error.message.length > 0);
});

test('remover o ULTIMO admin e rejeitado com LAST_ADMIN', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin'], [2, 'member']]),
		change: { userId: 1, remove: true },
		actorIsTriage: false,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, 'LAST_ADMIN');
});

test('remover membro comum nao dispara o guard', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin'], [2, 'member']]),
		change: { userId: 2, remove: true },
		actorIsTriage: false,
	});
	assert.strictEqual(result.ok, true);
});

test('triage faz bypass do LAST_ADMIN e a resposta sinaliza para audit', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin']]),
		change: { userId: 1, remove: true },
		actorIsTriage: true,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.bypassed, true);
});

test('mudanca que nao afeta admins nao vem com flag de bypass mesmo por triage', () => {
	const result = validateMemberChange({
		members: members([[1, 'admin'], [2, 'member']]),
		change: { userId: 2, role: 'admin' },
		actorIsTriage: true,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.bypassed, undefined);
});
