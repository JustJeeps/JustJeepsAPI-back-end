const test = require('node:test');
const assert = require('node:assert');

const { buildCardPayload } = require('../../services/trello/trelloService.js');
const { resolveCardDestination } = require('../../lib/trello/resolveDestination.js');

test('buildCardPayload monta nome REQ-n e desc com link de volta', () => {
	const payload = buildCardPayload(
		{
			id: 7,
			title: 'Tire filter wrong count',
			description: 'Counts do not match.',
			priority: 'High',
			project: 'Pricing Tool',
			type: 'Website Issue',
			requester: { username: 'david' },
		},
		'https://pricingtool.justjeeps.com'
	);
	assert.strictEqual(payload.name, 'REQ-7 — Tire filter wrong count');
	assert.ok(payload.desc.includes('Counts do not match.'));
	assert.ok(payload.desc.includes('Priority: High'));
	assert.ok(payload.desc.includes('https://pricingtool.justjeeps.com/requests?open=7'));
});

test('resolveCardDestination: sem assignee nao ha destino', () => {
	const result = resolveCardDestination({ request: { id: 1, assignee_id: null }, mapping: null });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.code, 'TRELLO_NO_ASSIGNEE');
});

test('resolveCardDestination: assignee sem board mapeado nao ha destino', () => {
	const result = resolveCardDestination({
		request: { id: 1, assignee_id: 5, assignee: { username: 'rafael' } },
		mapping: null,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.code, 'TRELLO_NO_BOARD_FOR_USER');
	assert.ok(result.reason.includes('rafael'));
});

test('resolveCardDestination: mapeamento presente resolve a lista do assignee', () => {
	const result = resolveCardDestination({
		request: { id: 1, assignee_id: 5, assignee: { username: 'rafael' } },
		mapping: { userId: 5, boardId: 'b1', listId: 'list-rafael' },
	});
	assert.deepStrictEqual(result, { ok: true, listId: 'list-rafael' });
});
