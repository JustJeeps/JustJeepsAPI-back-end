// Erro tipado da camada de servico de Requests. O route handler so mapeia
// { httpStatus, code, message } — regra de negocio nunca vira 403 (o
// interceptor do front desloga o usuario em 403 de auth).

class RequestServiceError extends Error {
	constructor(code, message, httpStatus = 409) {
		super(message);
		this.name = 'RequestServiceError';
		this.code = code;
		this.httpStatus = httpStatus;
	}

	static notFound(message = 'Request not found') {
		return new RequestServiceError('NOT_FOUND', message, 404);
	}

	static validation(message) {
		return new RequestServiceError('VALIDATION', message, 400);
	}

	static conflict(code, message) {
		return new RequestServiceError(code, message, 409);
	}
}

module.exports = { RequestServiceError };
