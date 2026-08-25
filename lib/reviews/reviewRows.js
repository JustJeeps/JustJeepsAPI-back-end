// Regras puras do import de reviews (docs/REVIEWS-IMPORT.md). Recebe linhas
// ja extraidas da planilha (array de arrays, header na primeira linha) e
// nunca toca xlsx/fs/rede — testavel via node --test.
//
// Planilha real: sku, email, nickname, rating, title, detail, date, status.
// email e status sao descartados de proposito (minimizacao de PII e campo
// sem destino na API); se um dia precisarem, e uma migration aditiva.

const crypto = require('crypto');

// Colunas obrigatorias (nomes do header, case-insensitive, qualquer ordem).
const REQUIRED_COLUMNS = ['sku', 'nickname', 'rating', 'title', 'detail', 'date'];

// Limites de campo: o texto vira HTML na loja — o Magento sanitiza, mas o
// nosso lado nao pode ser o vetor de payloads gigantes ou rating fora de 1..5.
const LIMITS = { sku: 64, nickname: 64, summary: 255, text: 5000 };

// SKU entra no path do GET de verificacao com o Bearer de producao: charset
// restrito aqui + encodeURIComponent no client (defesa em profundidade).
// Sem barra (mudaria o endpoint) e com pelo menos um alfanumerico ('..' puro
// nao e escapado pelo encodeURIComponent e viraria path traversal).
const SKU_PATTERN = /^(?=.*\w)[\w.-]{1,64}$/;

// Remove caracteres de controle (codigos < 32 e 127), preservando quebras de
// linha so no texto da review (keepNewlines). Loop por charCode de proposito:
// sem classe de caracteres com escapes, o comportamento fica obvio.
const NEWLINE_CODE = 10;
const stripControl = (value, { keepNewlines = false } = {}) => {
	let result = '';
	for (const char of String(value ?? '')) {
		const code = char.charCodeAt(0);
		const isControl = code < 32 || code === 127;
		if (!isControl || (keepNewlines && code === NEWLINE_CODE)) result += char;
	}
	return result.trim();
};

// Data em 3 formatos possiveis vindos do xlsx: Date (cellDates), string
// 'YYYY-MM-DD[ HH:mm:ss]' ou serial do Excel (dias desde 1899-12-30).
const EXCEL_EPOCH_OFFSET_DAYS = 25569; // dias entre 1899-12-30 e 1970-01-01
function normalizeReviewDate(value) {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString().slice(0, 10);
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		const ms = Math.round((value - EXCEL_EPOCH_OFFSET_DAYS) * 86400 * 1000);
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
	}
	const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (!match) return null;
	const [, year, month, day] = match;
	const roundtrip = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	const valid = roundtrip.getUTCFullYear() === Number(year)
		&& roundtrip.getUTCMonth() === Number(month) - 1
		&& roundtrip.getUTCDate() === Number(day);
	return valid ? `${year}-${month}-${day}` : null;
}

// rows[0] = header. Lanca em erro de ARQUIVO (coluna faltando — vira 400 no
// upload); erro de LINHA vira entrada em `invalid` (a planilha inteira nunca
// e rejeitada por algumas linhas ruins).
function parseReviewRows(rows) {
	if (!Array.isArray(rows) || rows.length === 0) throw new Error('Empty spreadsheet');
	const header = rows[0].map((cell) => String(cell ?? '').trim().toLowerCase());
	const columnIndex = {};
	for (const column of REQUIRED_COLUMNS) {
		const index = header.indexOf(column);
		if (index === -1) throw new Error(`Missing column "${column}" in the spreadsheet header`);
		columnIndex[column] = index;
	}

	const valid = [];
	const invalid = [];
	for (let i = 1; i < rows.length; i += 1) {
		const cells = rows[i] || [];
		if (cells.every((cell) => String(cell ?? '').trim() === '')) continue; // linha vazia
		const rowNumber = i + 1; // numero da linha na planilha (header = 1)

		const sku = stripControl(cells[columnIndex.sku]);
		const nickname = stripControl(cells[columnIndex.nickname]);
		const summary = stripControl(cells[columnIndex.title]);
		const text = stripControl(cells[columnIndex.detail], { keepNewlines: true });
		const ratingRaw = String(cells[columnIndex.rating] ?? '').trim();
		const ratingValue = Number(ratingRaw);
		const reviewDate = normalizeReviewDate(cells[columnIndex.date]);

		const problems = [];
		if (!SKU_PATTERN.test(sku)) problems.push('invalid sku');
		if (!nickname || nickname.length > LIMITS.nickname) problems.push('invalid nickname');
		if (!summary || summary.length > LIMITS.summary) problems.push('invalid summary (title)');
		if (!text || text.length > LIMITS.text) problems.push('invalid text (detail)');
		if (!Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 5) problems.push('invalid rating (1..5)');
		if (!reviewDate) problems.push('invalid date');

		if (problems.length) {
			invalid.push({ rowNumber, error: problems.join('; ') });
		} else {
			valid.push({ rowNumber, sku, nickname, summary, text, ratingValue, reviewDate });
		}
	}
	return { valid, invalid };
}

// Identidade da review pelo CONTEUDO (nao pela posicao/arquivo): e o que
// impede a mesma avaliacao de ser reenviada quando aparece em duas planilhas.
function reviewRowHash({ sku, nickname, summary, text, ratingValue, reviewDate }) {
	const material = [sku, nickname, reviewDate, ratingValue, summary, text]
		.map((value) => String(value ?? '').trim())
		.join('|');
	return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

// Shape do POST /products/reviews/bulk. Meio-dia segue o exemplo do dev da
// API (a planilha nao tem hora).
function toMagentoPayload({ sku, nickname, summary, text, ratingValue, reviewDate }) {
	return {
		sku,
		nickname,
		summary,
		text,
		rating_value: ratingValue,
		created_at: `${reviewDate} 12:00:00`,
	};
}

// Verificacao pos-crash: a review esta no Magento? O shape do GET e do dev da
// API (desconhecido em detalhe) — leitura defensiva com nomes alternativos.
// 'unverifiable' quando nada e legivel: NUNCA se assume ausencia sem prova.
function matchReview(row, magentoReviews) {
	if (!Array.isArray(magentoReviews)) return 'unverifiable';
	if (magentoReviews.length === 0) return 'absent';
	let readable = 0;
	for (const review of magentoReviews) {
		const nickname = review?.nickname ?? review?.nick_name;
		const summary = review?.summary ?? review?.title;
		const createdAt = review?.created_at ?? review?.createdAt;
		if (nickname === undefined && summary === undefined && createdAt === undefined) continue;
		readable += 1;
		const sameNickname = String(nickname ?? '').trim().toLowerCase() === row.nickname.trim().toLowerCase();
		const sameSummary = String(summary ?? '').trim() === row.summary.trim();
		const sameDate = String(createdAt ?? '').slice(0, 10) === row.reviewDate;
		if (sameNickname && sameSummary && sameDate) return 'matched';
	}
	return readable === 0 ? 'unverifiable' : 'absent';
}

function chunkRows(items, size) {
	const chunks = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

module.exports = { parseReviewRows, reviewRowHash, toMagentoPayload, matchReview, chunkRows };
