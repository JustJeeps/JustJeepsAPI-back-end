// Resolucao PURA do destino do card: o card vai para o board/lista do SETOR
// do request (boards por setor, 2026-08-11 — antes era o board do assignee).
// Sem mapeamento do setor nao ha destino — o chamador registra o motivo no
// activity log. Devolve tambem o boardId porque mover card entre boards
// (PUT /cards/:id) exige idBoard + idList.

function resolveCardDestination({ request, sectorMapping }) {
	if (!sectorMapping?.listId) {
		const sectorName = request?.sector?.name || `sector ${request?.sector_id}`;
		return {
			ok: false,
			code: 'TRELLO_NO_BOARD_FOR_SECTOR',
			reason: `Sector "${sectorName}" has no Trello board configured`,
		};
	}
	return { ok: true, boardId: sectorMapping.boardId, listId: sectorMapping.listId };
}

module.exports = { resolveCardDestination };
