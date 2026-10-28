// Team users. PASSWORDS DO NOT LIVE HERE: this file once had production
// passwords in plain text versioned in git (and baked into the Docker image),
// which gave anyone who cloned the repo a direct login to the API.
//
// Each password comes from a per-user env var:
//   SEED_USER_PASSWORD_<USERNAME in uppercase>   e.g. SEED_USER_PASSWORD_JACOB
// Without the env var, the seed GENERATES a random password and prints it a
// single time, to be handed over through the agreed secure channel (see
// prisma/seeds/seed-individual/seed-users.js and
// scripts/rotate-user-passwords.js).

module.exports = [
	{
		firstname: 'Jerry',
		lastname: 'Daudon',
		username: 'jerry',
		email: 'jerry@justjeeps.com',
	},
	{
		firstname: 'Jacob',
		lastname: 'Kemper',
		username: 'jacob',
		email: 'jkemper@justjeeps.com',
	},
	{
		firstname: 'David',
		lastname: 'Smith',
		username: 'david',
		email: 'dhunter@justjeeps.com',
	},
	{
		firstname: 'Paula',
		lastname: 'Gois',
		username: 'paula',
		email: 'pmello@justjeeps.com',
	},
	{
		firstname: 'Tess',
		lastname: 'Freire',
		username: 'tess',
		email: 'tsantos@justjeeps.com',
	},
	{
		firstname: 'Rafael',
		lastname: 'Pinheiro',
		username: 'rafael',
		email: 'rafaelp@justjeeps.com',
	},
];
