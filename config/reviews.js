// Import de reviews de produtos para o Magento (docs/REVIEWS-IMPORT.md):
// allowlist de quem opera a tela, limites de upload/parse e tuning do sync
// em lotes. O batch size e o delay protegem o site/banco de producao — por
// isso os clamps sao no codigo, nunca confiando so no env.
//
// IMPORTANTE: este modulo precisa continuar "puro" — apenas process.env e
// dados literais (mesma regra do config/cron-jobs.js), para que possa ser
// carregado por testes e scripts de validacao sem subir o servidor.

const { userAllowlist } = require('./allowlists');

const reviewsAllowedUsers = userAllowlist('REVIEWS_ALLOWED_USERS', 'ricardo,admin,rafael,tess');

function isReviewsUser(username) {
	return reviewsAllowedUsers.has(String(username || '').trim().toLowerCase());
}

// Numero invalido cai no default; valido e preso ao intervalo.
const clampNumber = (value, fallback, min, max) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
};

// So planilha. Mimetypes espelham o ATTACHMENT_ALLOWED_TYPES de
// config/requests.js: Windows/Excel manda application/vnd.ms-excel para .csv
// e alguns browsers mandam text/plain.
const REVIEWS_ALLOWED_TYPES = {
	'.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
	'.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

module.exports = {
	isReviewsUser,
	REVIEWS_ALLOWED_TYPES,
	config: {
		reviewsAllowedUsers,
		// ≤100 por chamada e a recomendacao do dev da API do Magento.
		batchSize: clampNumber(process.env.REVIEWS_SYNC_BATCH_SIZE, 50, 1, 100),
		batchDelayMs: clampNumber(process.env.REVIEWS_SYNC_BATCH_DELAY_MS, 1000, 500, 60000),
		// 10MB cobre com folga a planilha real (~25k linhas = 1.4MB); o teto
		// baixo protege o parse em memoria no container de 2GB (XLSX e ZIP).
		maxUploadBytes: clampNumber(process.env.REVIEWS_MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 1024, 50 * 1024 * 1024),
		maxRows: clampNumber(process.env.REVIEWS_MAX_ROWS, 60000, 100, 200000),
		insertChunkSize: 1000,
	},
};
