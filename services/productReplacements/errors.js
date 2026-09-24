// Typed error of the Product Replacement service layer. The route handler
// only maps { httpStatus, code, message }. A business rule violation is never
// a 403: the frontend interceptor logs the user out on an auth 403.

class ProductReplacementError extends Error {
	constructor(code, message, httpStatus = 409) {
		super(message);
		this.name = 'ProductReplacementError';
		this.code = code;
		this.httpStatus = httpStatus;
	}

	static notFound(code, message) {
		return new ProductReplacementError(code, message, 404);
	}

	static validation(message, code = 'VALIDATION') {
		return new ProductReplacementError(code, message, 400);
	}

	static conflict(code, message) {
		return new ProductReplacementError(code, message, 409);
	}
}

module.exports = { ProductReplacementError };
