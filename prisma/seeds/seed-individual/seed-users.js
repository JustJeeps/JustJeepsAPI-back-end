const bcrypt = require('bcryptjs');
const usersData = require('../hard-code_data/users_data.js');

const prisma = require('../../../lib/prisma');

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
    for (const userData of usersData) {
      const hashedPassword = await hashPassword(userData.password);
      
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username: userData.username },
            { email: userData.email }
          ]
        }
      });

      if (existingUser) {
        // Update existing user with hashed password
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            ...userData,
            password: hashedPassword
          }
        });
        console.log(`✅ Updated user: ${userData.username}`);
      } else {
        // Create new user
        await prisma.user.create({
          data: {
            ...userData,
            password: hashedPassword
          }
        });
        console.log(`✅ Created user: ${userData.username}`);
      }
    }

    console.log('🎉 User seeding completed successfully!');
    console.log('📝 Test credentials (when auth is enabled):');
    console.log('   Username: admin');
    console.log('   Password: adminpassword');
    
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