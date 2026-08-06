// Regra de arquivamento (pura, sem banco/express — testavel via node --test).
// Arquivar tira o chamado dos filtros padrao da tela sem apagar nada:
//   - so status concluido (DONE_STATUSES) pode ser arquivado;
//   - reabrir um chamado arquivado (status volta para um ativo) desarquiva
//     junto, senao ele ficaria ativo e invisivel na tela.

const { DONE_STATUSES } = require('../../config/requests');

// current: request atual; patch.archived: boolean|undefined; effectiveStatus:
// status depois do patch (inclui autoStatus).
// Retorna { ok: true, changed, archivedAt? } ou { ok: false, error: {code, message} }.
function resolveArchive({ current, patch, effectiveStatus }) {
	const isArchived = Boolean(current.archivedAt);

	if (patch.archived !== undefined && isArchived !== patch.archived) {
		if (patch.archived && !DONE_STATUSES.includes(effectiveStatus)) {
			return {
				ok: false,
				error: {
					code: 'ARCHIVE_ONLY_DONE',
					message: 'Only Completed or Closed requests can be archived',
				},
			};
		}
		return { ok: true, changed: true, archivedAt: patch.archived ? new Date() : null };
	}

	const statusChanged = effectiveStatus !== current.status;
	if (isArchived && statusChanged && !DONE_STATUSES.includes(effectiveStatus)) {
		return { ok: true, changed: true, archivedAt: null, unarchivedByReopen: true };
	}

	return { ok: true, changed: false };
}

module.exports = { resolveArchive };
