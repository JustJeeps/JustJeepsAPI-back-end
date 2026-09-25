// Central definitions of the Product Replacement feature (SKU substitutions
// registered by the team and consulted from the Orders screen).
//
// IMPORTANT: this module must stay "pure" (process.env and literals only,
// same rule as config/requests.js) so tests and scripts can load it without
// starting the server.

// Rollout gate. Released to every logged in user on 2026-09-25: the list is
// "*". To test a change with a few people again, set REPLACEMENTS_ALLOWED_USERS
// to a list of usernames in config/deploy.yml (username or the local part of
// the e-mail, like the Requests assignee managers).
const replacementsAllowedUsers = (process.env.REPLACEMENTS_ALLOWED_USERS || '*')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);
const replacementsEverybody = replacementsAllowedUsers.includes('*');

function isReplacementsUser(userOrUsername) {
	if (!userOrUsername) return false;
	if (replacementsEverybody) return true;
	const username = typeof userOrUsername === 'string'
		? userOrUsername.toLowerCase()
		: String(userOrUsername.username || '').toLowerCase();
	const emailLocalPart = typeof userOrUsername === 'string'
		? ''
		: String(userOrUsername.email || '').split('@')[0].toLowerCase();
	return replacementsAllowedUsers.includes(username)
		|| (emailLocalPart !== '' && replacementsAllowedUsers.includes(emailLocalPart));
}

// Managers can remove any association or comment. Everyone else can only
// remove what they created themselves (lib/productReplacements/rules.js).
const replacementsManagerUsers = (process.env.REPLACEMENTS_MANAGER_USERS || 'ricardo,admin,tess,paula')
	.split(/[,\s]+/)
	.map((username) => username.trim().toLowerCase())
	.filter(Boolean);

function isReplacementsManager(username) {
	return replacementsManagerUsers.includes(String(username || '').toLowerCase());
}

const SKU_MAX_LENGTH = 64;
const COMMENT_MAX_LENGTH = 2000;
// Directory list cap and the max number of SKUs accepted by the counts route
// (one call per expanded order, so a few dozen SKUs at most in practice).
const LIST_MAX = 500;
const COUNTS_MAX_SKUS = 200;
// Max replacements accepted in one create call (the modal saves a batch).
const CREATE_MAX_BATCH = 20;

module.exports = {
	isReplacementsUser,
	isReplacementsManager,
	SKU_MAX_LENGTH,
	COMMENT_MAX_LENGTH,
	LIST_MAX,
	COUNTS_MAX_SKUS,
	CREATE_MAX_BATCH,
	config: {
		replacementsAllowedUsers,
		replacementsEverybody,
		replacementsManagerUsers,
	},
};
