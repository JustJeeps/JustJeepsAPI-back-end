// Visibilidade por membership (decisao de 2026-08-12, substitui o "todos veem
// tudo"): um chamado e visivel para membros do setor dele, para quem o abriu
// (acompanha o proprio chamado em setor alheio), para quem esta atribuido e
// para triage. Modulo puro — o WHERE server-side de listRequests em
// requestsService e o ESPELHO desta regra; mudou aqui, muda la.

function canViewRequest({ request, userId, memberSectorIds, isTriage }) {
	if (isTriage === true) return true;
	if (!request || !userId) return false;
	if ((memberSectorIds || []).includes(request.sector_id)) return true;
	if (request.requester_id === userId) return true;
	if (request.assignee_id === userId) return true;
	return (request.assignees || []).some((entry) => (entry.user_id ?? entry.user?.id) === userId);
}

module.exports = { canViewRequest };
