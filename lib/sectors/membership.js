// Guard de orfandade do setor (padrao do research Trello/ClickUp: os dois
// produtos sofrem quando o unico admin de uma area sai e a recuperacao e
// limitada). Regra: nenhuma mudanca de membership pode deixar o setor sem
// admin. Triage global pode fazer bypass — o setor vira triage-managed — e o
// bypass volta sinalizado (`bypassed: true`) para o servico gravar no audit.
// Modulo puro: recebe a lista atual de membros + a mudanca, sem Prisma.

function validateMemberChange({ members, change, actorIsTriage }) {
	const remaining = (members || []).filter((member) => member.user_id !== change.userId);
	const changedIsAdmin = change.remove !== true && change.role === 'admin';
	const adminsAfter = remaining.filter((member) => member.role === 'admin').length + (changedIsAdmin ? 1 : 0);

	if (adminsAfter > 0) return { ok: true };
	if (actorIsTriage === true) return { ok: true, bypassed: true };
	return {
		ok: false,
		error: {
			code: 'LAST_ADMIN',
			message: 'Every sector needs at least one admin. Promote someone else before this change.',
		},
	};
}

module.exports = { validateMemberChange };
