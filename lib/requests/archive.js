// Regra de arquivamento (pura, sem banco/express — testavel via node --test).
// Arquivar tira o chamado dos filtros padrao da tela sem apagar nada.
//
// Decisoes de produto (2026-08-07):
//   - qualquer status pode ser arquivado (antes so Completed/Closed): serve
//     para tirar da tela um duplicado ou um chamado aberto por engano;
//   - so o AUTOR ou triage arquivam/desarquivam;
//   - arquivar e escolha explicita: mudar o status NAO desarquiva sozinho —
//     o chamado volta pelo botao Unarchive ou pela view Archived.

const { canManageRequest } = require('./permissions');

// patch.archived: boolean|undefined. Retorna
//   { ok: true, changed: false }                      — nada a fazer
//   { ok: true, changed: true, archivedAt: Date|null } — aplicar
//   { ok: false, error: { code, message } }            — sem permissao
function resolveArchive({ current, patch, user, isTriage }) {
	if (patch.archived === undefined) return { ok: true, changed: false };
	if (Boolean(current.archivedAt) === patch.archived) return { ok: true, changed: false };

	if (!canManageRequest({ request: current, user, isTriage })) {
		return {
			ok: false,
			error: {
				code: 'ARCHIVE_FORBIDDEN',
				message: 'Only the person who opened the request or a triage user can archive it',
			},
		};
	}

	return { ok: true, changed: true, archivedAt: patch.archived ? new Date() : null };
}

module.exports = { resolveArchive };
