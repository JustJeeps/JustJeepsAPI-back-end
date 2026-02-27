const bcrypt = require('bcryptjs');
const prisma = require('../../../lib/prisma');

const users = [
  {
    firstname: 'Jerry',
    lastname: 'Daudon',
    username: 'jerry',
    email: 'jerry@justjeeps.com',
    password: 'Jerry@2026jj',
  },
  {
    firstname: 'Jacob',
    lastname: 'Kemper',
    username: 'jacob',
    email: 'jkemper@justjeeps.com',
    password: 'Jacob@2026jj',
  },
  {
    firstname: 'Allison',
    lastname: 'Kemper',
    username: 'allison',
    email: 'allison@justjeeps.com',
    password: 'Allison@2026jj',
  },
  {
    firstname: 'David',
    lastname: 'Smith',
    username: 'david',
    email: 'dhunter@justjeeps.com',
    password: 'David@2026jj',
  },
  {
    firstname: 'Paula',
    lastname: 'Gois',
    username: 'paula',
    email: 'pmello@justjeeps.com',
    password: 'Paula@2026jj',
  },
  {
    firstname: 'Tess',
    lastname: 'Freire',
    username: 'tess',
    email: 'tsantos@justjeeps.com',
    password: 'Tess@2026jj',
  },
  {
    firstname: 'Rafael',
    lastname: 'Pinheiro',
    username: 'rafael',
    email: 'rafaelp@justjeeps.com',
    password: 'Rafael@2026jj',
  },
  {
    firstname: 'Karoline',
    lastname: 'Santos',
    username: 'karoline',
    email: 'kdiamantino@justjeeps.com',
    password: 'Karoline@2026jj',
  },
];

const seedNewUsers = async () => {
  try {
    console.log('🔐 Starting user seeding (all users except admin)...');
    console.log('');
    console.log('📝 Credentials (save these before continuing):');
    console.log('─'.repeat(55));
    for (const user of users) {
      console.log(`   ${user.firstname} ${user.lastname}`);
      console.log(`   Username: ${user.username}`);
      console.log(`   Email:    ${user.email}`);
      console.log(`   Password: ${user.password}`);
      console.log('─'.repeat(55));
    }
    console.log('');

    for (const userData of users) {
      const hashedPassword = await bcrypt.hash(userData.password, 10);

      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username: userData.username },
            { email: userData.email },
          ],
        },
      });

      if (existingUser) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            firstname: userData.firstname,
            lastname: userData.lastname,
            username: userData.username,
            email: userData.email,
            password: hashedPassword,
          },
        });
        console.log(`✅ Updated user: ${userData.username} (${userData.email})`);
      } else {
        await prisma.user.create({
          data: {
            firstname: userData.firstname,
            lastname: userData.lastname,
            username: userData.username,
            email: userData.email,
            password: hashedPassword,
          },
        });
        console.log(`✅ Created user: ${userData.username} (${userData.email})`);
      }
    }

    console.log('');
    console.log('🎉 User seeding completed successfully!');
    console.log('ℹ️  Admin user was NOT modified.');
  } catch (error) {
    console.error('❌ Error seeding users:', error);
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  seedNewUsers();
}

module.exports = seedNewUsers;
