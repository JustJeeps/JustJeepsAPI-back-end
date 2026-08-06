// Usuarios do time. As SENHAS NAO FICAM AQUI: este arquivo ja teve senhas de
// producao em texto puro versionadas no git (e embarcadas na imagem Docker), o
// que dava login direto na API a quem clonasse o repo.
//
// Cada senha vem de env por usuario:
//   SEED_USER_PASSWORD_<USERNAME em maiusculo>   ex.: SEED_USER_PASSWORD_JACOB
// Sem a env, o seed GERA uma senha aleatoria e imprime uma unica vez, para ser
// entregue pelo canal seguro combinado (ver prisma/seeds/seed-individual/
// seed-users.js e scripts/rotate-user-passwords.js).

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
