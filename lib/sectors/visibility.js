// Visibilidade por ownership/follow (decisao de 2026-08-31): um chamado e
// visivel para triage, para quem abriu, para quem esta atribuido e para quem
// foi adicionado como follower. Membership de setor por si so nao concede
// acesso ao chamado. Modulo puro — o WHERE server-side de listRequests em
// requestsService e o ESPELHO desta regra; mudou aqui, muda la.

function canViewRequest({ request, userId, memberSectorIds, isTriage }) {
	if (isTriage === true) return true;
	if (!request || !userId) return false;
	if (request.requester_id === userId) return true;
	if (request.assignee_id === userId) return true;
	if ((request.assignees || []).some((entry) => (entry.user_id ?? entry.user?.id) === userId)) return true;
	return (request.followers || []).some((entry) => (entry.user_id ?? entry.user?.id) === userId);
}

module.exports = { canViewRequest };
