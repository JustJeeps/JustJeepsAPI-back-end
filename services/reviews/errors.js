// Erro tipado da camada de servico de Reviews (molde services/requests/errors).
// O route handler so mapeia { httpStatus, code, message } — regra de negocio
// nunca vira 403 (o interceptor do front desloga o usuario em 403 de auth).

class ReviewsServiceError extends Error {
	constructor(code, message, httpStatus = 409) {
		super(message);
		this.name = 'ReviewsServiceError';
		this.code = code;
		this.httpStatus = httpStatus;
	}

	static notFound(message = 'Import file not found') {
		return new ReviewsServiceError('NOT_FOUND', message, 404);
	}

	static validation(message) {
		return new ReviewsServiceError('VALIDATION', message, 400);
	}

	static conflict(code, message) {
		return new ReviewsServiceError(code, message, 409);
	}
}

module.exports = { ReviewsServiceError };
