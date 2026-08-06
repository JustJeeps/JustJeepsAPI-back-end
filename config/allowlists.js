// Per-env user allowlists: who can run each sensitive operation (status in
// Magento, order cancellation, report sending...) changes when someone joins
// or leaves the team, and that cannot require a code deploy. The value in the
// code is only the default; production sets it in config/deploy.yml.
//
// IMPORTANT: this module has to stay "pure", only process.env and literal
// data (same rule as config/cron-jobs.js).

// Accepts "ana,bruno" or "ana bruno"; normalizes to lowercase and ignores
// empty entries. An env set to an empty string falls back to the default (a
// common deploy mistake); to allow nobody, set something that cannot match a
// real username.
function userAllowlist(envVar, fallback) {
	return new Set(
		String(process.env[envVar] || fallback)
			.split(/[,\s]+/)
			.map((username) => username.trim().toLowerCase())
			.filter(Boolean)
	);
}

module.exports = { userAllowlist };
