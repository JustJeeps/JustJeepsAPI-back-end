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

// Boards por setor (2026-08-11): o destino do card e o board/lista do SETOR
// do chamado — o mapeamento por assignee foi aposentado junto com os codes
// TRELLO_NO_ASSIGNEE / TRELLO_NO_BOARD_FOR_USER.

test('resolveCardDestination: setor sem board mapeado nao ha destino', () => {
	const result = resolveCardDestination({
		request: { id: 1, sector_id: 3, sector: { id: 3, name: 'TI' } },
		sectorMapping: null,
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.code, 'TRELLO_NO_BOARD_FOR_SECTOR');
	assert.ok(result.reason.includes('TI'));
});

test('resolveCardDestination: mapeamento do setor resolve board e lista', () => {
	const result = resolveCardDestination({
		request: { id: 1, sector_id: 3, sector: { id: 3, name: 'TI' } },
		sectorMapping: { sectorId: 3, boardId: 'b-ti', listId: 'list-ti' },
	});
	assert.deepStrictEqual(result, { ok: true, boardId: 'b-ti', listId: 'list-ti' });
});

test('resolveCardDestination: destino nao depende de assignee', () => {
	const result = resolveCardDestination({
		request: { id: 1, sector_id: 3, sector: { id: 3, name: 'TI' }, assignee_id: null },
		sectorMapping: { sectorId: 3, boardId: 'b-ti', listId: 'list-ti' },
	});
	assert.strictEqual(result.ok, true);
});

test('buildCardPayload inclui a linha do setor quando presente', () => {
	const payload = buildCardPayload(
		{
			id: 9,
			title: 'Slow page',
			description: 'Home takes 10s.',
			priority: 'Normal',
			project: 'Pricing Tool',
			type: 'Website Issue',
			requester: { username: 'paula' },
			sector: { name: 'TI' },
		},
		'https://pricingtool.justjeeps.com'
	);
	assert.ok(payload.desc.includes('Sector: TI'));
});
