// Client da API de reviews do Magento (endpoints do dev da loja). Especifico
// de reviews de proposito — os demais call sites Magento do repo sao
// heterogeneos; extrair um client generico e tarefa para quando a SEGUNDA
// feature sair do monolito (regra de tres).
//
// Molde lib/trello/trelloClient.js: http injetavel para os testes rodarem sem
// rede, e o erro cru do axios NUNCA e relancado — ele carrega o Bearer em
// config.headers e vazaria o token no primeiro console.error. Todo erro sai
// como Error novo com { code, outcomeKnown }:
//   outcomeKnown=true  -> o Magento certamente NAO gravou (seguro decidir);
//   outcomeKnown=false -> desfecho desconhecido (timeout/5xx) — quem chama
//                         NUNCA pode reenviar sem verificar antes via GET.

const axios = require('axios');

const MAGENTO_TIMEOUT_DEFAULT_MS = 15000;

// Mesma logica do resolveMagentoBaseUrl de server.js:2232 (nao exportado —
// duplicacao minima aceita para nao mexer no monolito): devolve so a origem,
// cortando qualquer /rest/... que venha no env. Default SEM www: os endpoints
// de reviews vivem em justjeeps.com (o www responde 307, comprovado no smoke
// de 2026-08-25 — e um redirect nao pode carregar um POST com Bearer).
function resolveMagentoBaseUrl(env = {}) {
	const raw = String(env.MAGENTO_BASE_URL || env.M2_BASE_URL || 'https://justjeeps.com').trim();
	const restIndex = raw.indexOf('/rest/');
	const origin = restIndex === -1 ? raw : raw.slice(0, restIndex);
	return origin.replace(/\/+$/, '');
}

function toMagentoError(error) {
	const status = error.response?.status;
	const detail = String(error.response?.data?.message || '').slice(0, 160);
	const make = (code, outcomeKnown, message) => {
		const mapped = new Error(message);
		mapped.code = code;
		mapped.outcomeKnown = outcomeKnown;
		return mapped;
	};
	if (status === 401 || status === 403) return make('MAGENTO_AUTH_FAILED', true, 'Magento authentication failed (check MAGENTO_KEY)');
	if (status === 429) return make('MAGENTO_RATE_LIMITED', true, 'Magento rate limited the request');
	if (status >= 400 && status < 500) {
		return make('MAGENTO_BAD_REQUEST', true, `Magento rejected the request (${status})${detail ? `: ${detail}` : ''}`);
	}
	if (error.code === 'ECONNREFUSED') {
		// Conexao recusada: a requisicao nem chegou ao servidor — desfecho conhecido.
		return make('MAGENTO_UNAVAILABLE', true, 'Magento connection refused');
	}
	return make('MAGENTO_UNAVAILABLE', false, `Magento API unavailable (${status || error.code || 'network error'})`);
}

function createMagentoReviewsClient({ http = axios, env = process.env } = {}) {
	const baseUrl = resolveMagentoBaseUrl(env);
	const timeout = Number(env.MAGENTO_TIMEOUT_MS || MAGENTO_TIMEOUT_DEFAULT_MS);
	// MAGENTO_REVIEWS_KEY: token dedicado, se o dev emitir um so com o ACL
	// JWA_ProductReviewApi (o smoke de 2026-08-25 mostrou que o MAGENTO_KEY
	// atual nao tem o resource bulk_create). Sem ele, usa o token geral.
	const token = () => env.MAGENTO_REVIEWS_KEY || env.MAGENTO_KEY;
	const requestConfig = () => ({
		headers: {
			Authorization: `Bearer ${token()}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		timeout,
	});

	const isConfigured = () => Boolean(token());

	async function getReviewsBySku(sku) {
		try {
			const response = await http.get(
				`${baseUrl}/rest/default/V1/products/${encodeURIComponent(sku)}/reviews`,
				requestConfig()
			);
			// Shape real do endpoint (verificado em prod 2026-08-25):
			// { sku, rating_summary, review_count, reviews: [...] }. Devolve o
			// array; qualquer outro shape passa adiante e o matchReview decide
			// (defensivo: shape ilegivel nunca vira "ausente").
			const { data } = response;
			if (Array.isArray(data)) return data;
			if (Array.isArray(data?.reviews)) return data.reviews;
			return data;
		} catch (error) {
			throw toMagentoError(error);
		}
	}

	async function postReviewsBulk(reviews) {
		try {
			const response = await http.post(
				`${baseUrl}/rest/default/V1/products/reviews/bulk`,
				{ reviews },
				requestConfig()
			);
			return { status: response.status };
		} catch (error) {
			throw toMagentoError(error);
		}
	}

	return { isConfigured, getReviewsBySku, postReviewsBulk, baseUrl: () => baseUrl };
}

module.exports = { createMagentoReviewsClient, resolveMagentoBaseUrl };
