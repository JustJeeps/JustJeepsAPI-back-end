// Quem pode mexer no ciclo de vida de um chamado (arquivar, desarquivar,
// deletar): o AUTOR e os usuarios de triage. Modulo puro — o front tem o
// espelho em requestsConstants.js para decidir o que mostrar, mas quem manda
// e esta regra, aplicada no servico.

function canManageRequest({ request, user, isTriage }) {
	if (!request || !user) return false;
	return isTriage === true || request.requester_id === user.id;
}

// Restaurar um chamado deletado e mais restrito: so triage. Deletar e uma
// acao do autor, desfazer e decisao de quem cuida da fila.
function canRestoreRequest({ isTriage }) {
	return isTriage === true;
}

module.exports = { canManageRequest, canRestoreRequest };
