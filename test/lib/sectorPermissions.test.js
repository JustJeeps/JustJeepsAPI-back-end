const test = require('node:test');
const assert = require('node:assert');

const {
	roleFor,
	canManageSector,
	canCreateSector,
	canMoveRequest,
	slugify,
} = require('../../lib/sectors/permissions.js');

// Modulo puro: decide o papel efetivo de um usuario num setor e o que cada
// papel pode fazer. Politica adotada (research Trello/ClickUp, plano
// use-o-resarche-para-stateful-rossum.md): triage global e o "workspace admin"
// do Trello — enxerga e gerencia todos os setores, sem opt-in.

test('roleFor: triage global tem papel triage mesmo sem membership', () => {
	assert.strictEqual(roleFor({ membership: null, isTriage: true }), 'triage');
});

test('roleFor: triage prevalece sobre membership comum', () => {
	const membership = { role: 'member' };
	assert.strictEqual(roleFor({ membership, isTriage: true }), 'triage');
});

test('roleFor: admin do setor', () => {
	assert.strictEqual(roleFor({ membership: { role: 'admin' }, isTriage: false }), 'admin');
});

test('roleFor: membro comum do setor', () => {
	assert.strictEqual(roleFor({ membership: { role: 'member' }, isTriage: false }), 'member');
});

test('roleFor: sem membership e sem triage e null', () => {
	assert.strictEqual(roleFor({ membership: null, isTriage: false }), null);
});

test('roleFor: role desconhecida no banco degrada para member (nao escala privilegio)', () => {
	assert.strictEqual(roleFor({ membership: { role: 'banana' }, isTriage: false }), 'member');
});

test('canManageSector: triage e admin gerenciam, member e null nao', () => {
	assert.strictEqual(canManageSector({ role: 'triage' }), true);
	assert.strictEqual(canManageSector({ role: 'admin' }), true);
	assert.strictEqual(canManageSector({ role: 'member' }), false);
	assert.strictEqual(canManageSector({ role: null }), false);
});

test('canCreateSector: so triage cria setores (anti-sprawl)', () => {
	assert.strictEqual(canCreateSector({ isTriage: true }), true);
	assert.strictEqual(canCreateSector({ isTriage: false }), false);
});

test('canMoveRequest: triage ou admin do setor de ORIGEM', () => {
	assert.strictEqual(canMoveRequest({ isTriage: true, isSourceAdmin: false }), true);
	assert.strictEqual(canMoveRequest({ isTriage: false, isSourceAdmin: true }), true);
	assert.strictEqual(canMoveRequest({ isTriage: false, isSourceAdmin: false }), false);
});

test('slugify: minusculas, sem acentos, espacos viram hifen', () => {
	assert.strictEqual(slugify('Atendimento ao Cliente'), 'atendimento-ao-cliente');
	assert.strictEqual(slugify('Operações & Logística'), 'operacoes-logistica');
});

test('slugify: colapsa separadores repetidos e apara pontas', () => {
	assert.strictEqual(slugify('  TI -- Infra  '), 'ti-infra');
});

test('slugify: entrada vazia devolve string vazia', () => {
	assert.strictEqual(slugify(''), '');
	assert.strictEqual(slugify(null), '');
});
