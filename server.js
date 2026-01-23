const Express = require('express');
const { format, parseISO } = require('date-fns');
const app = Express();
const BodyParser = require('body-parser');
const PORT = process.env.PORT || 8080
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});
const seedOrders = require('./prisma/seeds/seed-individual/seed-orders.js');
const quadratecProducts = require('./prisma/seeds/api-calls/quadratec-excel.js');
const { getWheelProsSkus, makeApiRequestsInChunks } = require('./prisma/seeds/api-calls/wheelPros-api.js');

// 🔐 Import authentication components (safe - disabled by default)
const authRoutes = require('./routes/auth');
const { authenticateToken, optionalAuth } = require('./middleware/auth');
require('dotenv').config();

// Use cors middleware - allow both local and ngrok
app.use(
  cors({
    origin: [
      "http://localhost:5173", // local frontend
      "https://orderapi.nunchisolucoes.com/", // ngrok frontend
    ],
    credentials: true,
  })
);

// app.use(cors()); // Old permissive CORS - now replaced with specific origins


// Express Configuration
app.use(BodyParser.urlencoded({ extended: false }));
app.use(BodyParser.json());
app.use(Express.static('public'));

// 🔐 Authentication routes (safe - disabled by default via ENABLE_AUTH=false)
app.use('/api/auth', authRoutes);

// Health check endpoint para Kamal/Load Balancer
app.get('/api/health', async (req, res) => {
	try {
		// Verifica conexao com o banco
		await prisma.$queryRaw`SELECT 1`;
		res.status(200).json({
			status: 'healthy',
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
		});
	} catch (error) {
		res.status(503).json({
			status: 'unhealthy',
			error: 'Database connection failed',
			timestamp: new Date().toISOString(),
		});
	}
});

// Sample GET route
app.get('/', (req, res) =>
	res.json({
		message: 'Seems to work!',
	})
);

// Sample GET route
app.get('/api/data', (req, res) =>
	res.json({
		message: '/api/data route works!',
	})
);

// Route for getting all wheelPros products
app.get('/api/wheelPros', async (req, res) => {
  try {
    const skus = await getWheelProsSkus();
    const allResults = await makeApiRequestsInChunks(skus, 50);
    res.json(allResults);
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch products ${error}` });
  }
});


// Route for getting all Quadratec products
app.get('/api/quadratec', async (req, res) => {
	try {
		const products = await quadratecProducts();
		res.json(products);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});


// Route for getting top 5 products by qty_ordered
app.get('/top5skus', async (req, res) => {
	try {
		const top5Skus = await prisma.orderProduct.groupBy({
			by: ['sku'],
			_sum: {
				qty_ordered: true,
			},
			orderBy: {
				_sum: {
					qty_ordered: 'desc',
				},
			},
			take: 10,
		});

		const top5SkusWithProducts = await Promise.all(
			top5Skus.map(async orderProduct => {
				const product = await prisma.product.findUnique({
					where: {
						sku: orderProduct.sku,
					},
				});
				return {
					...orderProduct,
					product,
				};
			})
		);

		res.json(top5SkusWithProducts);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: `${error}` });
	}
});

//Route for getting all products sku, only return the id
app.get('/api/products_sku', async (req, res) => {
	try {
		const products = await prisma.product.findMany({
			select: {
				sku: true,
			},
			take: 20001,
		});
		res.json(products);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});

// GET /api/products/:sku/brand  →  { brand: "Lube Locker" }
app.get('/api/products/:sku/brand', async (req, res) => {
  try {
    const p = await prisma.product.findUnique({
      where: { sku: req.params.sku },
      select: { brand_name: true },
    });
    res.json({ brand: p?.brand_name || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch brand' });
  }
});


//Route for getting all products
app.get('/api/products', async (req, res) => {
	try {
		const products = await prisma.product.findMany({
			select: {
				sku: true,
				name: true,
				url_path: true,
				status: true,
				price: true,
				MAP: true,
				searchable_sku: true,
				jj_prefix: true,
				image: true,
				brand_name: true,
				vendors: true,
				partStatus_meyer: true,
				keystone_code: true,
				//add meyer_weight, meyer_length, meyer_width, meyer_height
				meyer_weight: true,
				meyer_length: true,
				meyer_width: true,
				meyer_height: true,
				weight: true,
				length: true,
				width: true,
				height: true,
				black_friday_sale: true,
				shippingFreight: true,
				partsEngine_code: true,
				tdot_url: true,
				keystone_code_site: true,
				part: true,
				thumbnail: true,
				vendorProducts: {
					select: {
						product_sku: true,
						vendor_sku: true,
						vendor_cost: true,
						vendor_inventory: true,
						vendor_inventory_string: true,
						partStatus_meyer: true,
						quadratec_sku: true,
						vendor: {
							select: {
								name: true,
							},
						},
					},
				},
				competitorProducts: {
					select: {
						competitor_price: true,
						product_url: true,
						competitor: {
							select: {
								name: true,
							},
						},
					},
				},
				// take: 5000,
			},
			// take: 20
		});

		res.json(products);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});

//Route for getting all products by sku
app.get('/api/products/:sku', async (req, res) => {
	try {
		const product = await prisma.product.findUnique({
			where: {
				sku: req.params.sku,
			},
			select: {
				sku: true,
				name: true,
				url_path: true,
				status: true,
				price: true,
				MAP: true,
				searchable_sku: true,
				jj_prefix: true,
				image: true,
				brand_name: true,
				vendors: true,
				partStatus_meyer: true,
				keystone_code: true,
				//add meyer_weight, meyer_length, meyer_width, meyer_height
				meyer_weight: true,
				meyer_length: true,
				meyer_width: true,
				meyer_height: true,
				weight: true,
				length: true,
				width: true,
				height: true,
				shippingFreight: true,
				partsEngine_code: true,
				black_friday_sale: true,
				tdot_url: true,
				keystone_code_site: true,
				part: true,
				thumbnail: true,
				vendorProducts: {
					select: {
						product_sku: true,
						vendor_sku: true,
						vendor_cost: true,
						vendor_inventory: true,
						vendor_inventory_string: true,
						quadratec_sku: true,
						vendor: {
							select: {
								name: true,
							},
						},
					},
				},
				competitorProducts: {
					select: {
						competitor_price: true,
						product_url: true,
						competitor: {
							select: {
								name: true,
							},
						},
					},
				},
			},
		});
		res.json(product);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch product' });
	}
});

app.get('/brands', async (req, res) => {
	try {
		const uniqueBrandNames = await prisma.product.findMany({
			distinct: ['brand_name'],
			select: {
				brand_name: true,
			},
		});

		res.json(uniqueBrandNames);
	} catch (error) {
		console.error(error);
		res.status(500).send('Internal server error');
	}
});

//* Routes for Orders *\\

// Route for getting all orders
// app.get('/api/orders', async (req, res) => {
//   try {
//     const orders = await prisma.order.findMany({
//       include: {
//         items: {
//           include: {
//             product: true,
//           },
//           where: {
//             base_price: {
//               gt: 0
//             },
// 		
//           },
//         },
//       },
//       orderBy: {
//         created_at: 'desc'
//       },
//     });
//     res.json(orders);
//   } catch (error) {
//     res.status(500).json({
//       error: `${error} Failed to fetch orders`
//     });
//   }
// });


// Route for getting orders where custom_po_number contains "not set"
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        items: {
          include: {
            product: true,
          },
          where: {
            base_price: {
              gt: 0
            },
          },
        },
      },
      // where: {
      //   custom_po_number: {
      //     contains: 'Not set'
      //   }
      // },
      orderBy: {
        created_at: 'desc'
      },
    });
    res.json(orders);
  } catch (error) {
    res.status(500).json({
      error: `${error} Failed to fetch orders`
    });
  }
});

app.get('/api/seed-orders', async (req, res) => {
  try {
    await seedOrders();
    res.status(200).send('Orders seeded successfully');
  } catch (error) {
    console.error("Error seeding data:", error);
    res.status(500).send('Error seeding data');
  }
});

//Route for getting a single order
app.get('/api/orders/:id', async (req, res) => {
	try {
		const order = await prisma.order.findUnique({
			where: {
				entity_id: Number(req.params.id),
			},
		});
		res.json(order);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch order' });
	}
});

// Route for updating an order status
app.post('/api/orders/:id/edit', async (req, res) => {
	try {
		console.log(req.body);
		const order = await prisma.order.update({
			where: {
				entity_id: Number(req.params.id),
			},
			data: {
				// status: req.body.status,
				customer_email: req.body.customer_email,
				// coupon_code: req.body.coupon_code,
				customer_firstname: req.body.customer_firstname,
				customer_lastname: req.body.customer_lastname,
				grand_total: parseFloat(req.body.grand_total),
				base_total_due: parseFloat(req.body.base_total_due),
				// increment_id: req.body.increment_id,
				// order_currency_code: req.body.order_currency_code,
				total_qty_ordered: parseFloat(req.body.total_qty_ordered),
				shipping_firstname,
        shipping_lastname,
        shipping_postcode,
        shipping_street1,
        shipping_street2,
        shipping_street3,
        shipping_telephone,
        shipping_city,
        shipping_region,
        shipping_country_id,
				shipping_company
			},
		});
		console.log(order);
		res.json(order);
	} catch (error) {
		res.status(500).json({ error: 'Failed to update order' });
	}
});

//Route for deleting an order
app.post('/api/orders/:id/delete', async (req, res) => {
	try {
		const order = await prisma.order.delete({
			where: {
				entity_id: Number(req.params.id),
			},
		});
		res.json(order);
	} catch (error) {
		res.status(500).json({ error: 'Failed to delete order' });
	}
});

//* Routes for Product Orders *\\

//Route for getting all product orders
app.get('/api/order_products', async (req, res) => {
	try {
		const productOrders = await prisma.orderProduct.findMany({
			include: {
				order: true,
				product: true,
			},
		});
		res.json(productOrders);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch product orders' });
	}
});

// Route for creating an order product
app.post('/order_products', async (req, res) => {
	try {
		const {
			order_id,
			name,
			sku,
			base_price,
			base_price_incl_tax,
			discount_amount,
			discount_invoiced,
			discount_percent,
			original_price,
			price,
			price_incl_tax,
			product_id,
			qty_ordered,
		} = req.body;
		const createdOrderProduct = await prisma.orderProduct.create({
			data: {
				order_id: order_id,
				name: name,
				sku: sku,
				base_price: base_price,
				base_price_incl_tax: base_price_incl_tax,
				discount_amount: discount_amount,
				discount_invoiced: discount_invoiced,
				discount_percent: discount_percent,
				original_price: original_price,
				price: price,
				price_incl_tax: price_incl_tax,
				product_id: product_id,
				qty_ordered: qty_ordered,
			},
		});
		res.json(createdOrderProduct);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to create order product' });
	}
});

// Route for editing an order product
app.post('/order_products/:id/edit', async (req, res) => {
	try {
		const id = req.params.id;
		const {
			name,
			sku,
			base_price,
			base_price_incl_tax,
			discount_amount,
			discount_invoiced,
			discount_percent,
			original_price,
			price,
			price_incl_tax,
			product_id,
			qty_ordered,
			selected_supplier,
			selected_supplier_cost,
		} = req.body;
		const updatedOrderProduct = await prisma.orderProduct.update({
			where: {
				id: Number(id),
			},
			data: {
				name: name,
				sku: sku,
				base_price: base_price,
				base_price_incl_tax: base_price_incl_tax,
				discount_amount: discount_amount,
				discount_invoiced: discount_invoiced,
				discount_percent: discount_percent,
				original_price: original_price,
				price: parseFloat(price),
				price_incl_tax: price_incl_tax,
				product_id: product_id,
				qty_ordered: parseFloat(qty_ordered),
				selected_supplier: selected_supplier,
				selected_supplier_cost: selected_supplier_cost,
			},
		});
		res.json(updatedOrderProduct);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to update order product' });
	}
});

// Route for editing an order product
app.post('/order_products/:id/edit/selected_supplier', async (req, res) => {
	try {
		const id = req.params.id;
		const {
			name,
			sku,
			base_price,
			base_price_incl_tax,
			discount_amount,
			discount_invoiced,
			discount_percent,
			original_price,
			price,
			price_incl_tax,
			product_id,
			qty_ordered,
			selected_supplier,
			selected_supplier_cost,
		} = req.body;
		const updatedOrderProduct = await prisma.orderProduct.update({
			where: {
				id: Number(id),
			},
			data: {
				name: name,
				sku: sku,
				base_price: base_price,
				base_price_incl_tax: base_price_incl_tax,
				discount_amount: discount_amount,
				discount_invoiced: discount_invoiced,
				discount_percent: discount_percent,
				original_price: original_price,
				price: price,
				price_incl_tax: price_incl_tax,
				product_id: product_id,
				qty_ordered: qty_ordered,
				selected_supplier: selected_supplier,
				selected_supplier_cost: selected_supplier_cost,
			},
		});
		res.json(updatedOrderProduct);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to update order product' });
	}
});

// Route for deleting an order product
app.delete('/order_products/:id/delete', async (req, res) => {
	try {
		const id = parseInt(req.params.id);

		// Delete the order product from the database using Prisma
		await prisma.orderProduct.delete({
			where: { id },
		});

		// res.redirect(204, '/orders');
		const orders = await prisma.order.findMany({
			include: {
				items: true,
			},
		});
		res.json(orders);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Failed to delete order product' });
	}
});

//* Routes for Vendor Products *\\

// Route for getting all vendor products
app.get('/api/vendor_products', async (req, res) => {
	try {
		// vendor products including order products and vendor
		const vendorProducts = await prisma.vendorProduct.findMany({
			include: {
				vendor: true,
				product: true,
			},
		});
		// Extracting only the necessary fields from the query result
		const vendorProductsResult = vendorProducts.map(
			({ product_sku, vendor_cost }) => ({
				product_sku,
				vendor_cost,
			})
		);

		res.json(vendorProductsResult);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to vendor products' });
	}
});

// Route for getting vendor products by sku
app.get('/api/vendor_products/:sku', async (req, res) => {
	console.log(req.params.sku);
	try {
		const vendorProduct = await prisma.vendorProduct.findMany({
			where: {
				product_sku: req.params.sku,
			},
			include: {
				vendor: true,
				product: true,
			},
		});
		res.json(vendorProduct);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch vendor product' });
	}
});

// Route for getting Vendors info
app.get('/api/vendors', async (req, res) => {
	try {
		const vendors = await prisma.vendor.findMany();
		res.json(vendors);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch vendors' });
	}
});

//get all vendornproducts by vendor id
app.get('/api/vendor_products/vendor/:id', async (req, res) => {
	try {
		const vendorProducts = await prisma.vendorProduct.findMany({
			where: {
				vendor_id: parseInt(req.params.id),
			},
		});
		res.json(vendorProducts);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch vendor products' });
	}
});

//* Routes for Purchase Orders *\\

// Route for getting all Purchase Orders
// app.get("/api/purchase_orders", async (req, res) => {
//   try {
//     const purchaseOrders = await prisma.purchaseOrder.findMany({
//       include: {
//         vendor: true,
//         user: true,
//         order: {
//           include: {
//             items: true,
//           },
//         },
//         purchaseOrderLineItems: {
//           include: {
//             vendorProduct: true,
//             purchaseOrder: true,
//           },
//         },
//       },
//     });
//     res.json(purchaseOrders);
//   } catch (error) {
//     console.log(error);
//     res.status(500).json({ error: "Failed to fetch purchase orders" });
//   }
// });

app.get('/api/purchase_orders', async (req, res) => {
	try {
		const purchaseOrders = await prisma.purchaseOrder.findMany({
			include: {
				purchaseOrderLineItems: true,
			},
		});
		res.json(purchaseOrders);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch purchase orders' });
	}
});

// Route for getting latest Purchase Orders by vendor
app.get('/api/purchase_orders/vendor/:id', async (req, res) => {
	try {
		const purchaseOrders = await prisma.purchaseOrder.findMany({
			where: {
				vendor_id: Number(req.params.id),
			},
			include: {
				vendor: true,
				user: true,
				order: {
					include: {
						items: true,
					},
				},
				purchaseOrderLineItems: {
					include: {
						purchaseOrder: true,
					},
				},
			},
			orderBy: {
				created_at: 'desc',
			},
			take: 10, // Limit the results to 10 latest Purchase Orders
		});
		res.json(purchaseOrders);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch purchase orders' });
	}
});


// Route for getting a single Purchase Order
app.get('/api/purchase_orders/:id', async (req, res) => {
	const purchaseOrder = await prisma.purchaseOrder.findUnique({
		where: {
			id: Number(req.params.id),
		},
		include: {
			vendor: true,
			user: true,
			order: true,
			purchaseOrderLineItems: {
				include: {
					vendorProduct: true,
					purchaseOrder: true,
				},
			},
		},
	});
	res.json(purchaseOrder);
});

// Route for creating a Purchase Order

// Route for creating a Purchase Order
app.post('/api/purchase_orders', async (req, res) => {
	try {
		const { vendor_id, user_id, order_id } = req.body;

		// Check if a purchase order already exists for the given order_id and vendor_id
		const existingPurchaseOrder = await prisma.purchaseOrder.findFirst({
			where: {
				vendor_id: vendor_id,
				order_id: order_id,
			},
		});

		if (existingPurchaseOrder) {
			// A purchase order already exists, return it
			return res.json(existingPurchaseOrder);
		}

		// Create a new purchase order
		const purchaseOrder = await prisma.purchaseOrder.create({
			data: {
				vendor_id: vendor_id,
				user_id: user_id,
				order_id: order_id,
			},
			include: {
				vendor: true,
				user: true,
				order: true,
				purchaseOrderLineItems: {
					include: {
						purchaseOrder: true,
					},
				},
			},
		});

		res.json(purchaseOrder);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to create purchase order' });
	}
});

// Route for creating or updating a Purchase Order Line Item
app.post('/purchaseOrderLineItem', async (req, res) => {
	try {
		const {
			purchaseOrderId,
			vendorProductId,
			quantityPurchased,
			vendorCost,
			product_sku,
			vendor_sku,
		} = req.body;

		console.log(req.body);
		let purchaseOrderLineItem = await prisma.purchaseOrderLineItem.findFirst({
			where: {
				purchase_order_id: purchaseOrderId,
				product_sku: product_sku,
			},
		});

		console.log(purchaseOrderLineItem);

		if (!purchaseOrderLineItem) {
			purchaseOrderLineItem = await prisma.purchaseOrderLineItem.create({
				data: {
					purchase_order_id: purchaseOrderId,
					quantity_purchased: quantityPurchased,
					vendor_cost: vendorCost,
					product_sku: product_sku,
					vendor_sku: vendor_sku,
				},
			});
		} else {
			purchaseOrderLineItem = await prisma.purchaseOrderLineItem.update({
				where: {
					id: purchaseOrderLineItem.id,
				},
				data: {
					quantity_purchased: quantityPurchased,
					vendor_cost: vendorCost,
				},
			});
		}

		res.status(201).json(purchaseOrderLineItem);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Something went wrong' });
	}
});

// Route for updating a Purchase Order
app.post('/api/purchase_orders/:id/update', async (req, res) => {
	try {
		const purchaseOrder = await prisma.purchaseOrder.update({
			where: {
				id: Number(req.params.id),
			},
			data: {
				vendor_id: req.body.vendor_id,
				user_id: req.body.user_id,
				order_id: req.body.order_id,
			},
			include: {
				vendor: true,
				user: true,
				order: true,
				purchaseOrderLineItems: {
					include: {
						vendorProduct: true,
						purchaseOrder: true,
					},
				},
			},
		});
		res.json(purchaseOrder);
	} catch (error) {
		res.status(500).json({ error: 'Failed to update purchase order' });
	}
});

// Route for deleting a Purchase Order
app.post('/api/purchase_orders/:id/delete', async (req, res) => {
	try {
		const purchaseOrder = await prisma.purchaseOrder.delete({
			where: {
				id: Number(req.params.id),
			},
		});
		res.json(purchaseOrder);
	} catch (error) {
		res.status(500).json({ error: 'Failed to delete purchase order' });
	}
});

// Route for getting the grand total and total count of all orders
app.get('/totalOrderInfo', async (req, res) => {
	try {
		const result = await prisma.order.aggregate({
			_sum: {
				grand_total: true,
				total_qty_ordered: true,
			},
			_count: {
				_all: true,
			},
			_avg: {
				grand_total: true,
			},
		});
		const totalSum = result._sum.grand_total;
		const totalQty = result._sum.total_qty_ordered;
		const count = result._count._all;
		const avg = result._avg.grand_total;
		res.json({ totalSum, count, avg, totalQty });
	} catch (error) {
		console.error(`Error getting total sum of grand_total: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	} finally {
		await prisma.$disconnect();
	}
});

//Route for getting the total of all orders by month
app.get('/totalGrandTotalByMonth', async (req, res) => {
	try {
		const orders = await prisma.order.findMany();
		const totalByMonth = orders.reduce((acc, order) => {
			const month = format(parseISO(order.created_at), 'yyyy-MM');
			if (!acc[month]) {
				acc[month] = 0;
			}
			acc[month] += order.grand_total;
			return acc;
		}, {});
		const currentMonth = format(new Date(), 'yyyy-MM');
		const lastMonth = format(new Date().setDate(0), 'yyyy-MM');
		res.json({
			orders,
			total_by_month: totalByMonth,
			total_this_month: totalByMonth[currentMonth],
			total_last_month: totalByMonth[lastMonth],
		});
	} catch (error) {
		console.error(`Error getting total by month: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

// // Route for get all products info
app.get('/productinfo', async (req, res) => {
	try {
		const countProduct = await prisma.product.aggregate({
			_count: {
				_all: true,
			},
		});
		const orderProduct = await prisma.orderProduct.aggregate({
			_sum: {
				qty_ordered: true,
			},
		});
		res.json({
			numProduct: countProduct._count._all,
			totalSold: orderProduct._sum.qty_ordered,
		});
	} catch (error) {
		console.error(`Error getting products info: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

// Route for top 10 popular products
app.get('/toppopularproduct', async (req, res) => {
	const result3 = [];
	try {
		const result1 = await prisma.orderProduct.groupBy({
			by: ['sku'],
			_sum: {
				qty_ordered: true,
			},
			orderBy: {
				_sum: {
					qty_ordered: 'desc',
				},
			},
			take: 10,
		});
		// const result3 = result1.map(async (item) => {
		//   const result2 = await prisma.product.findUnique({
		//     where: {
		//       sku:item.sku,
		//     }
		//   });
		//   return result2;
		// })
		// const result = await Promise.all(result3);
		for (let i = 0; i < result1.length; i++) {
			const result2 = await prisma.product.findUnique({
				where: {
					sku: result1[i].sku,
				},
			});
			result3.push({ ...result1[i]._sum, ...result2 });
		}
		res.json(result3);
	} catch (error) {
		console.error(`Error getting top 10 popular products info: ${error}`);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(
		`Express seems to be listening on port ${PORT} so that's pretty good 👍`
	);
});
