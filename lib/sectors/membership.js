// Guard de orfandade do setor (padrao do research Trello/ClickUp: os dois
// produtos sofrem quando o unico admin de uma area sai e a recuperacao e
// limitada). Regra: nenhuma mudanca de membership pode deixar o setor sem
// admin. Triage global pode fazer bypass — o setor vira triage-managed — e o
// bypass volta sinalizado (`bypassed: true`) para o servico gravar no audit.
// Modulo puro: recebe a lista atual de membros + a mudanca, sem Prisma.

function validateMemberChange({ members, change, actorIsTriage }) {
	const list = members || [];
	const remaining = list.filter((member) => member.user_id !== change.userId);
	const changedIsAdmin = change.remove !== true && change.role === 'admin';
	const adminsBefore = list.filter((member) => member.role === 'admin').length;
	const adminsAfter = remaining.filter((member) => member.role === 'admin').length + (changedIsAdmin ? 1 : 0);

	if (adminsAfter > 0) return { ok: true };
	// bypassed so quando a mudanca DE FATO remove/rebaixa o ultimo admin. Num
	// setor ja triage-managed (zero admins — recem-criado ou pos-bypass), uma
	// mudanca que nao toca em admin nao pode carimbar lastAdminBypass no audit.
	if (actorIsTriage === true) {
		return adminsBefore > 0 ? { ok: true, bypassed: true } : { ok: true };
	}
	return {
		ok: false,
		error: {
			code: 'LAST_ADMIN',
			message: 'Every sector needs at least one admin. Promote someone else before this change.',
		},
	};
}

module.exports = { validateMemberChange };
