// Allowlist de usuarios de triage: quem pode fazer operacoes administrativas
// que escrevem em producao (subir feed de vendor, disparar o script de um feed
// pelo painel).
//
// IMPORTANTE: este modulo precisa continuar "puro" — apenas process.env e
// dados literais (mesma regra do config/cron-jobs.js), para poder ser carregado
// por testes e scripts de validacao sem subir o servidor.
//
// FEEDS_TRIAGE_USERS e a env propria; REQUESTS_TRIAGE_USERS e aceita como
// fallback porque ja esta provisionada no deploy com a mesma lista.

const triageUsers = (process.env.FEEDS_TRIAGE_USERS || process.env.REQUESTS_TRIAGE_USERS || 'ricardo,rafael')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function isTriageUser(username) {
	return triageUsers.includes(String(username || '').toLowerCase());
}

module.exports = { isTriageUser, config: { triageUsers } };
