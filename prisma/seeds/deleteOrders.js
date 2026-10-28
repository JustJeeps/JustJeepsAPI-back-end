//delete orders from the database
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const deleteOrders = async () => {
  try {
    await prisma.order.deleteMany();
    console.log('Orders deleted successfully.');
  } catch (error) {
    console.error('Error deleting orders:', error);
  } finally {
    await prisma.$disconnect();
  }
}

deleteOrders();
//     console.log(response.data);
//     return response.data;
//   } catch (error) {
//     console.error(error);
//   }
// };
