// Triage user allowlist: who can run administrative operations that write to
// production (upload a vendor feed, trigger a feed script from the panel).
//
// IMPORTANT: this module has to stay "pure", only process.env and literal
// data (same rule as config/cron-jobs.js), so it can be loaded by tests and
// validation scripts without booting the server.
//
// FEEDS_TRIAGE_USERS is the dedicated env; REQUESTS_TRIAGE_USERS is accepted
// as a fallback because it is already provisioned in the deploy with the same
// list.

const triageUsers = (process.env.FEEDS_TRIAGE_USERS || process.env.REQUESTS_TRIAGE_USERS || 'ricardo,rafael')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function isTriageUser(username) {
	return triageUsers.includes(String(username || '').toLowerCase());
}

module.exports = { isTriageUser, config: { triageUsers } };
