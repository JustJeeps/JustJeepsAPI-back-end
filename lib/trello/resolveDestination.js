// Resolucao PURA do destino do card: o card vai para o board/lista do
// ASSIGNEE do request (decisao de produto — cada usuario tem seu board,
// mapeado pelo painel /settings). Sem assignee ou sem mapeamento, nao ha
// destino — o chamador registra o motivo no activity log.

function resolveCardDestination({ request, mapping }) {
	if (!request?.assignee_id) {
		return { ok: false, code: 'TRELLO_NO_ASSIGNEE', reason: 'Request has no assignee' };
	}
	if (!mapping?.listId) {
		const username = request.assignee?.username || `user ${request.assignee_id}`;
		return {
			ok: false,
			code: 'TRELLO_NO_BOARD_FOR_USER',
			reason: `Assignee "${username}" has no Trello board configured`,
		};
	}
	return { ok: true, listId: mapping.listId };
}

module.exports = { resolveCardDestination };
