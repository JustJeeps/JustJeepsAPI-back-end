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

const REQUEST_PROJECTS = [
	'Just Jeeps — US Website',
	'Just Jeeps — CA Website',
	'Pricing Tool',
	'Magento / Backend',
	'Integrations',
	'Internal / Other',
];

const REQUEST_TYPES = [
	'Website Issue',
	'Product / Data Issue',
	'Improvement / Suggestion',
	'Investigation / Test',
	'Access / Configuration',
	'Other',
];

// Triage: quem pode atribuir/desatribuir e fechar (Closed). Allowlist por
// username via env (evolucao do padrao de allowlists do server.js:99-110).
const requestsTriageUsers = (process.env.REQUESTS_TRIAGE_USERS || 'ricardo,rafael')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function isTriageUser(username) {
	return requestsTriageUsers.includes(String(username || '').toLowerCase());
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
	ATTACHMENT_ALLOWED_TYPES,
	isTriageUser,
	config: {
		requestsTriageUsers,
		attachmentsMaxFileSizeBytes,
		attachmentsMaxFilesPerUpload,
	},
};
