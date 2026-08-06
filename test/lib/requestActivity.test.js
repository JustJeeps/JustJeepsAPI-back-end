const test = require('node:test');
const assert = require('node:assert');

const { diffToActivities } = require('../../lib/requests/activity.js');

// Modulo puro: compara o estado atual com o patch aplicado e devolve as
// entradas de RequestActivity — sem contato com o banco.

const current = (overrides = {}) => ({
	status: 'New Request',
	assignee_id: null,
	priority: 'Normal',
	title: 'Old title',
	description: 'Old description',
	project: 'Pricing Tool',
	type: 'Website Issue',
	links: [],
	...overrides,
});

test('mudanca de status vira status_change com old/new', () => {
	const entries = diffToActivities({
		requestId: 1,
		actorId: 9,
		current: current({ status: 'Assigned' }),
		applied: { status: 'Work in Progress' },
	});
	assert.strictEqual(entries.length, 1);
	assert.deepStrictEqual(entries[0], {
		request_id: 1,
		actor_id: 9,
		action: 'status_change',
		field: 'status',
		oldValue: 'Assigned',
		newValue: 'Work in Progress',
	});
});

test('sair de Closed vira reopened', () => {
	const entries = diffToActivities({
		requestId: 1,
		actorId: 9,
		current: current({ status: 'Closed' }),
		applied: { status: 'Assigned' },
	});
	assert.strictEqual(entries[0].action, 'reopened');
});

test('mudanca de assignee usa os labels legiveis', () => {
	const entries = diffToActivities({
		requestId: 1,
		actorId: 9,
		current: current({ assignee_id: 2 }),
		applied: { assignee_id: 3 },
		labels: { oldAssignee: 'ricardo', newAssignee: 'rafael' },
	});
	assert.strictEqual(entries[0].action, 'assignee_change');
	assert.strictEqual(entries[0].oldValue, 'ricardo');
	assert.strictEqual(entries[0].newValue, 'rafael');
});

test('prioridade e campos de texto geram entradas separadas', () => {
	const entries = diffToActivities({
		requestId: 1,
		actorId: 9,
		current: current(),
		applied: { priority: 'Urgent', title: 'New title' },
	});
	const actions = entries.map((entry) => entry.action).sort();
	assert.deepStrictEqual(actions, ['field_update', 'priority_change']);
});

test('valores iguais nao geram entrada', () => {
	const entries = diffToActivities({
		requestId: 1,
		actorId: 9,
		current: current(),
		applied: { priority: 'Normal', title: 'Old title', links: [] },
	});
	assert.deepStrictEqual(entries, []);
});

test('valores longos sao truncados', () => {
	const entries = diffToActivities({
		requestId: 1,
		actorId: 9,
		current: current(),
		applied: { description: 'x'.repeat(1000) },
	});
	assert.ok(entries[0].newValue.length <= 300);
});
