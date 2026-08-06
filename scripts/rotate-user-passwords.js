/* eslint-disable no-console */
// Rotates user passwords. Needed because production passwords ended up
// versioned in git (prisma/seeds/hard-code_data/users_data.js and commit
// 806566b^ with seed-new-users.js), so any old clone of the repo still holds
// valid credentials.
//
// Usage:
//   npm run rotate-passwords                      # DRY RUN: shows what it would do
//   npm run rotate-passwords -- --confirm         # applies to ALL users
//   npm run rotate-passwords -- --user rafael --confirm
//   npm run rotate-passwords -- --user admin --disable --confirm
//
// Behavior:
//   - generates a strong random password per user and stores only the bcrypt
//     hash;
//   - prints the passwords ONCE (hand them over through the agreed secure
//     channel);
//   - --disable replaces the password with a random value that is NOT printed,
//     leaving the account effectively unreachable (use it for the "admin" test
//     account);
//   - nothing else on the user row is changed.

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
		console.log('No user matched the given filters.');
		return;
	}

	console.log(`${args.confirm ? '🔐 ROTATING' : '🔎 DRY RUN'}: ${users.length} user(s):`);
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
		console.log('\nNothing was changed. Review the list and run again with --confirm.');
		return;
	}

	if (args.disable) {
		console.log('\n🚫 Accounts disabled: the new password is random and was NOT printed.');
		return;
	}

	console.log('\n🔑 New passwords (shown ONCE, copy them now and hand them over through the secure channel):');
	for (const cred of issued) {
		console.log(`   ${cred.username.padEnd(12)} ${cred.password}`);
	}
	console.log('\nAfter handing them out, ask each person to change it on first login.');
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
