const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const fixVendorInventoryString = async () => {
  try {
    const affectedVendorProducts = await prisma.vendorProduct.findMany({
      where: {
        vendor_inventory: 0,
        vendor_inventory_string: "no info",
      },
    });

    console.log(`Found ${affectedVendorProducts.length} vendorProducts to update.`);

    for (const vp of affectedVendorProducts) {
      await prisma.vendorProduct.update({
        where: { id: vp.id },
        data: { vendor_inventory_string: null },
      });
      console.log(`Updated vendorProduct ID ${vp.id}`);
    }

    console.log("All matching vendorProducts updated successfully.");
  } catch (error) {
    console.error("Error updating vendor_inventory_string:", error);
  } finally {
    await prisma.$disconnect();
  }
};

fixVendorInventoryString();
