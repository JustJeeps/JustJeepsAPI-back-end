const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const usersData = require('../hard-code_data/users_data.js');

const prisma = require('../../../lib/prisma');

// Guard against running against production by accident: this script CREATES
// users and (before) reset the password of anyone who already existed. The
// .env.production file sits on the developer machine next to .env, so an
// "npm run seed-users" with the wrong env rewrote the team credentials.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== '1') {
  console.error('❌ Refusing to run with NODE_ENV=production without ALLOW_PROD_SEED=1');
  process.exit(1);
}

// Password from env (SEED_USER_PASSWORD_<USER>) or random, never from the repo.
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
        // NEVER rewrite the password of someone who already exists: running the
        // seed again must not break the credential in use. Changing a password
        // is the job of scripts/rotate-user-passwords.js, explicit and with a
        // confirmation step.
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
      console.log('\n🔑 Generated passwords (shown ONCE; hand them over through the secure channel):');
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