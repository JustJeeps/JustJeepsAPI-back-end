/* eslint-disable no-console */
// Rotaciona senhas de usuarios. Necessario porque senhas de producao ficaram
// versionadas no git (prisma/seeds/hard-code_data/users_data.js e o commit
// 806566b^ com seed-new-users.js), entao qualquer clone antigo do repo ainda
// tem credenciais validas.
//
// Uso:
//   npm run rotate-passwords                      # DRY RUN: mostra o que faria
//   npm run rotate-passwords -- --confirm         # aplica em TODOS os usuarios
//   npm run rotate-passwords -- --user rafael --confirm
//   npm run rotate-passwords -- --user admin --disable --confirm
//
// Comportamento:
//   - gera senha aleatoria forte por usuario e grava apenas o hash bcrypt;
//   - imprime as senhas UMA vez (entregar pelo canal seguro combinado);
//   - --disable troca a senha por um valor aleatorio NAO impresso, deixando a
//     conta efetivamente inacessivel (usar para a conta "admin" de teste);
//   - nao altera mais nada da linha do usuario.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');

const parseArgs = (argv) => {
	const args = { confirm: false, disable: false, users: [] };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--confirm') args.confirm = true;
		else if (argv[i] === '--disable') args.disable = true;
		else if (argv[i] === '--user') args.users.push(String(argv[++i] || '').toLowerCase());
	}
	return args;
};

const strongPassword = () => `${crypto.randomBytes(15).toString('base64url')}!`;

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const where = args.users.length > 0
		? { OR: args.users.map((username) => ({ username: { equals: username, mode: 'insensitive' } })) }
		: {};
	const users = await prisma.user.findMany({ where, select: { id: true, username: true, email: true } });

	if (users.length === 0) {
		console.log('Nenhum usuario encontrado para os filtros informados.');
		return;
	}

	console.log(`${args.confirm ? '🔐 ROTACIONANDO' : '🔎 DRY RUN'} — ${users.length} usuario(s):`);
	const issued = [];

	for (const user of users) {
		const password = strongPassword();
		if (args.confirm) {
			await prisma.user.update({
				where: { id: user.id },
				data: { password: await bcrypt.hash(password, 10) },
			});
		}
		issued.push({ username: user.username, email: user.email, password });
		console.log(`   ${args.confirm ? '✅' : '•'} ${user.username} <${user.email}>`);
	}

	if (!args.confirm) {
		console.log('\nNada foi alterado. Reveja a lista e rode de novo com --confirm.');
		return;
	}

	if (args.disable) {
		console.log('\n🚫 Contas desativadas: a senha nova e aleatoria e NAO foi impressa.');
		return;
	}

	console.log('\n🔑 Senhas novas (aparecem UMA vez — copie agora e entregue pelo canal seguro):');
	for (const cred of issued) {
		console.log(`   ${cred.username.padEnd(12)} ${cred.password}`);
	}
	console.log('\nDepois de distribuir, peca para cada pessoa trocar no primeiro acesso.');
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
