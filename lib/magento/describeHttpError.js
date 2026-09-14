// Reduces an axios error to what a log line needs: status, code, message
// and url. The full AxiosError carries the request headers (Authorization:
// Bearer <MAGENTO_KEY>) and the HTML body of the upstream error page; the
// order seeds used to console.error() the whole object, so every Magento
// outage wrote the API token into prisma/seeds/logs and, from there, into
// the archive on DO Spaces (2026-09-13 incident). Errors that did not come
// from axios are returned untouched so their stack trace still reaches
// the log.

function describeHttpError(error) {
	if (!error || typeof error !== 'object' || !error.isAxiosError) return error;

	return {
		status: Number.isFinite(error.response?.status) ? error.response.status : null,
		code: error.code || null,
		message: error.message || null,
		url: error.config?.url || null,
	};
}

module.exports = { describeHttpError };
