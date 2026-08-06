const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const usersData = require('../hard-code_data/users_data.js');

const prisma = require('../../../lib/prisma');

// Guarda contra rodar sem querer contra producao: este script CRIA usuarios e
// (antes) resetava senha de quem ja existia. O .env.production fica na maquina
// do dev ao lado do .env, entao um "npm run seed-users" com o env errado
// reescrevia as credenciais do time.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== '1') {
  console.error('❌ Recusando rodar com NODE_ENV=production sem ALLOW_PROD_SEED=1');
  process.exit(1);
}

// Senha por env (SEED_USER_PASSWORD_<USER>) ou aleatoria — nunca do repositorio.
const passwordFor = (username) => {
  const fromEnv = process.env[`SEED_USER_PASSWORD_${username.toUpperCase()}`];
  if (fromEnv) return { password: fromEnv, generated: false };
  return { password: crypto.randomBytes(12).toString('base64url'), generated: true };
};

const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

const seedUsers = async () => {
  try {
    console.log('🔐 Starting user seeding with hashed passwords...');
    
    // Delete existing users (optional - comment out if you want to keep existing)
    // await prisma.user.deleteMany();
    // console.log('Cleared existing users');

    // Hash passwords and create users
    const generatedCredentials = [];

    for (const userData of usersData) {
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username: { equals: userData.username, mode: 'insensitive' } },
            { email: { equals: userData.email, mode: 'insensitive' } }
          ]
        }
      });

      if (existingUser) {
        // NUNCA reescrever a senha de quem ja existe: rodar o seed de novo nao
        // pode derrubar a credencial em uso. Troca de senha e trabalho do
        // scripts/rotate-user-passwords.js, explicito e com confirmacao.
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            firstname: userData.firstname,
            lastname: userData.lastname,
            email: userData.email
          }
        });
        console.log(`ℹ️  User already exists, password untouched: ${userData.username}`);
      } else {
        const { password, generated } = passwordFor(userData.username);
        await prisma.user.create({
          data: {
            ...userData,
            password: await hashPassword(password)
          }
        });
        if (generated) generatedCredentials.push({ username: userData.username, password });
        console.log(`✅ Created user: ${userData.username}`);
      }
    }

    if (generatedCredentials.length > 0) {
      console.log('\n🔑 Senhas geradas (aparecem UMA vez; entregue pelo canal seguro):');
      for (const cred of generatedCredentials) {
        console.log(`   ${cred.username}: ${cred.password}`);
      }
    }

    console.log('🎉 User seeding completed successfully!');
    
  } catch (error) {
    console.error('❌ Error seeding users:', error);
  } finally {
    await prisma.$disconnect();
  }
};

// Run if called directly
if (require.main === module) {
  seedUsers();
}

module.exports = seedUsers;