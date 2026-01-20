const { PrismaClient } = require('@prisma/client');
const vendorsData = require('./hard-code_data/vendors_data');

const prisma = new PrismaClient();

async function seedVendorsOnly() {
  console.log('🏪 Seeding vendors data only...');
  
  try {
    // First, check current vendors
    const existingVendors = await prisma.vendor.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true }
    });
    
    console.log(`📊 Current vendors in database (${existingVendors.length}):`);
    existingVendors.forEach(v => console.log(`   ${v.id}: ${v.name}`));
    
    // Find vendors that need to be added
    const vendorsToAdd = vendorsData.filter(vendor => 
      !existingVendors.find(existing => existing.name === vendor.name)
    );
    
    console.log(`\n🆕 Vendors to add (${vendorsToAdd.length}):`);
    vendorsToAdd.forEach(v => console.log(`   - ${v.name}`));
    
    if (vendorsToAdd.length === 0) {
      console.log('\n✅ All vendors already exist in database!');
      return;
    }
    
    // Add missing vendors
    let created = 0;
    for (const vendor of vendorsToAdd) {
      try {
        const newVendor = await prisma.vendor.create({ data: vendor });
        console.log(`   ✅ Created: ${vendor.name} (ID ${newVendor.id})`);
        created++;
      } catch (error) {
        console.log(`   ❌ Failed to create ${vendor.name}: ${error.message}`);
      }
    }
    
    console.log(`\n📊 Summary: ${created} vendors created`);
    
    // Show final vendor list with MetalCloak and Premier Performance highlighted
    const finalVendors = await prisma.vendor.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true }
    });
    
    console.log(`\n🏪 Final vendor list (${finalVendors.length}):`);
    finalVendors.forEach(v => {
      const highlight = (v.name === 'MetalCloak' || v.name === 'Premier Performance') ? '🆕 ' : '   ';
      console.log(`${highlight}${v.id}: ${v.name}`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

seedVendorsOnly().catch(console.error);