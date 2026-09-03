// Definicoes centrais da feature de Requests (chamados internos do Pricing
// Tool): status, prioridades, projects, types e allowlist de triage.
//
// IMPORTANTE: este modulo precisa continuar "puro" — apenas process.env e
// dados literais (mesma regra do config/cron-jobs.js), para que possa ser
// carregado por testes e scripts de validacao sem subir o servidor.

// Ordem = ordem do workflow e ordem de exibicao na UI.
const REQUEST_STATUSES = [
	{ name: 'New Request', color: '#a855f7' },
	{ name: 'Estimation', color: '#0b8ce9' },
	{ name: 'Assigned', color: '#f97316' },
	{ name: 'Work in Progress', color: '#10a35a' },
	{ name: 'Awaiting Client Response', color: '#fbbf24' },
	{ name: 'On Hold', color: '#ef4444' },
	{ name: 'Completed', color: '#2563eb' },
	{ name: 'Closed', color: '#1a8c5c' },
];

const REQUEST_STATUS_NAMES = REQUEST_STATUSES.map((status) => status.name);

// Status que exigem um comentario explicando o porque na mesma transicao.
const COMMENT_REQUIRED_STATUSES = ['Awaiting Client Response', 'On Hold', 'Completed'];

const REQUEST_PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];
const DEFAULT_PRIORITY = 'Normal';

// Listas revisadas em 2026-08-21 (draft aprovado com a Tess). A validacao so
// vale para escritas novas: chamados antigos mantem os valores anteriores
// ("Just Jeeps — US Website", "Website Issue", ...) e continuam legiveis.
const REQUEST_PROJECTS = [
	'Just Jeeps — Canadian Website',
	'Just Jeeps — U.S. Website',
	'Just Jeeps — Both Websites',
	'Magento Backend',
	'Pricing Tool',
	'PO Tool',
	'Helpdesk Ticket System',
	'Integrations',
	'Other',
];

const REQUEST_TYPES = [
	'Fix an Issue / Something Not Working',
	'Product Information / Image / Fitment Correction',
	'Pricing Update',
	'Change / Improvement Request',
	'Investigation / Testing',
	'Access / Settings Change',
	'Other',
];

// Triage: quem pode atribuir/desatribuir e fechar (Closed). Allowlist por
// username via env (evolucao do padrao de allowlists do server.js:99-110).
const requestsTriageUsers = (process.env.REQUESTS_TRIAGE_USERS || 'ricardo,admin,tess')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function isTriageUser(username) {
	return requestsTriageUsers.includes(String(username || '').toLowerCase());
}

// Atribuicao de responsavel: por decisao atual, somente estes usuarios podem
// definir/remover assignees (default: tess).
const requestsAssigneeManagers = (process.env.REQUESTS_ASSIGNEE_MANAGERS || 'tess')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function canAssignRequestAssignees(username) {
	return requestsAssigneeManagers.includes(String(username || '').toLowerCase());
}

// Status "concluidos": usados para a lane Done do board e para esconder da
// view "All open". NAO controla mais quem pode arquivar — desde 07/08
// qualquer status e arquivavel pelo autor ou triage (lib/requests/archive.js).
const DONE_STATUSES = ['Completed', 'Closed'];

// Feature gate (rollout): while the team tests, only these users see and use
// the requests feature. Release = widen the env (or set it to the whole team).
const requestsAllowedUsers = (process.env.REQUESTS_ALLOWED_USERS || 'ricardo,admin,tess')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function isRequestsUser(username) {
	return requestsAllowedUsers.includes(String(username || '').toLowerCase());
}

// Limites de anexos (multer + validacao no front).
const attachmentsMaxFileSizeBytes = Number(process.env.REQUEST_ATTACHMENTS_MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const attachmentsMaxFilesPerUpload = Number(process.env.REQUEST_ATTACHMENTS_MAX_FILES || 5);

// Allowlist de extensao -> mimetypes aceitos (evidencias de chamados:
// screenshots, PDFs, planilhas e logs).
const ATTACHMENT_ALLOWED_TYPES = {
	'.png': ['image/png'],
	'.jpg': ['image/jpeg'],
	'.jpeg': ['image/jpeg'],
	'.webp': ['image/webp'],
	'.gif': ['image/gif'],
	'.pdf': ['application/pdf'],
	'.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
	'.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
	'.txt': ['text/plain'],
	'.log': ['text/plain', 'application/octet-stream'],
	'.mp4': ['video/mp4'],
	'.mov': ['video/quicktime'],
};

module.exports = {
	REQUEST_STATUSES,
	REQUEST_STATUS_NAMES,
	COMMENT_REQUIRED_STATUSES,
	REQUEST_PRIORITIES,
	DEFAULT_PRIORITY,
	REQUEST_PROJECTS,
	REQUEST_TYPES,
	DONE_STATUSES,
	ATTACHMENT_ALLOWED_TYPES,
	isTriageUser,
	isRequestsUser,
	canAssignRequestAssignees,
	config: {
		requestsTriageUsers,
		requestsAllowedUsers,
		requestsAssigneeManagers,
		attachmentsMaxFileSizeBytes,
		attachmentsMaxFilesPerUpload,
	},
};
