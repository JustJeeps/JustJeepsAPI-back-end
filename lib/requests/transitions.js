// Maquina de estados dos Requests (chamados internos). Modulo puro: recebe o
// estado atual + patch + flag de triage e devolve o veredito — nenhum contato
// com banco/express, para ser testavel via node --test.

const { REQUEST_STATUS_NAMES, COMMENT_REQUIRED_STATUSES } = require('../../config/requests');

// patch.assigneeId: number = atribuir, null = desatribuir, undefined = nao mexer.
// Retorna { ok: true, autoStatus? } ou { ok: false, error: { code, message } }.
function validateChange({ current, patch, isTriage }) {
	const fail = (code, message) => ({ ok: false, error: { code, message } });

	const touchesAssignee = patch.assigneeId !== undefined;
	const touchesStatus = patch.status !== undefined && patch.status !== current.status;

	// Decisao de produto (2026-08-03): qualquer usuario pode atribuir/desatribuir.
	// Fechar chamado continua restrito a triage (regra abaixo).

	if (patch.status !== undefined && !REQUEST_STATUS_NAMES.includes(patch.status)) {
		return fail('INVALID_STATUS', `Unknown status "${patch.status}"`);
	}

	if (touchesStatus && current.status === 'Closed' && patch.status !== 'Assigned') {
		return fail('INVALID_TRANSITION', 'A closed request can only be reopened to Assigned');
	}

	if (touchesStatus && patch.status === 'Closed' && !isTriage) {
		return fail('TRIAGE_ONLY', 'Only triage users can close requests');
	}

	const effectiveAssigneeId = touchesAssignee ? patch.assigneeId : current.assignee_id;
	if (touchesStatus && patch.status === 'Assigned' && effectiveAssigneeId == null) {
		return fail('ASSIGNEE_REQUIRED', 'Moving to Assigned requires an assignee');
	}

	if (
		touchesStatus &&
		COMMENT_REQUIRED_STATUSES.includes(patch.status) &&
		!String(patch.comment || '').trim()
	) {
		return fail('COMMENT_REQUIRED', `A comment is required to move to ${patch.status}`);
	}

	// Atribuir alguem a um chamado recem-criado ja o move para Assigned
	// (comportamento do design: onAssignee em New Request).
	const result = { ok: true };
	if (
		touchesAssignee &&
		patch.assigneeId != null &&
		!touchesStatus &&
		current.status === 'New Request'
	) {
		result.autoStatus = 'Assigned';
	}
	return result;
}

// Estado inicial de um chamado novo: espelho do autoStatus acima — nascer
// com assignee e nascer Assigned (primeiro da lista = primario).
function initialStateFor({ assigneeIds = [] } = {}) {
	return {
		status: assigneeIds.length ? 'Assigned' : 'New Request',
		assigneeId: assigneeIds[0] ?? null,
	};
}

module.exports = { validateChange, initialStateFor };
