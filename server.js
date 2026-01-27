const Express = require('express');
const { format, parseISO } = require('date-fns');
const app = Express();
const BodyParser = require('body-parser');
const PORT = process.env.PORT || 8080
const cors = require('cors');
const cron = require('node-cron');
const { spawn } = require('child_process');
const logger = require('./utils/logger');
const { sendCronNotification } = require('./utils/emailService');
const prisma = require('./lib/prisma');
const seedOrders = require('./prisma/seeds/seed-individual/seed-orders.js');
const quadratecProducts = require('./prisma/seeds/api-calls/quadratec-excel.js');
const { getWheelProsSkus, makeApiRequestsInChunks } = require('./prisma/seeds/api-calls/wheelPros-api.js');

// 🔐 Import authentication components (safe - disabled by default)
const authRoutes = require('./routes/auth');
const { authenticateToken, optionalAuth } = require('./middleware/auth');
require('dotenv').config();

// Use cors middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173", // local frontend
      "https://lionfish-app-v8v9s.ondigitalocean.app", // production frontend
			"https://orderapi.nunchisolucoes.com"
    ],
    credentials: true,
  })
);

// app.use(cors()); // Old permissive CORS - now replaced with specific origins


// Express Configuration
app.use(BodyParser.urlencoded({ extended: false }));
app.use(BodyParser.json());
app.use(Express.static('public'));

// Request logging middleware (Axiom)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Only log non-health-check requests to reduce noise
    if (req.path !== '/api/health') {
      logger.request(req, res, duration);
    }
  });
  next();
});

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

// 🔐 Apply authentication middleware to all routes below this point
// Public routes: /api/auth/*, /api/health, /
// Protected routes: all other /api/* routes
app.use('/api', authenticateToken);

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


//Route for getting all products (with pagination)
app.get('/api/products', async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 50;
		const skip = (page - 1) * limit;
		const search = req.query.search || '';

		// Build where clause for search
		const where = search ? {
			OR: [
				{ sku: { contains: search, mode: 'insensitive' } },
				{ name: { contains: search, mode: 'insensitive' } },
				{ brand_name: { contains: search, mode: 'insensitive' } },
				{ searchable_sku: { contains: search, mode: 'insensitive' } },
			]
		} : {};

		const selectFields = {
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
		};

		// Run query and count in parallel for better performance
		const [products, total] = await Promise.all([
			prisma.product.findMany({
				where,
				skip,
				take: limit,
				select: selectFields,
			}),
			prisma.product.count({ where })
		]);

		res.json({
			products,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
				hasMore: page * limit < total
			}
		});
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch products' });
	}
});

//Route for getting all products by brand name
app.get('/api/products/brand/:brandName', async (req, res) => {
	try {
		const brandName = decodeURIComponent(req.params.brandName);

		const products = await prisma.product.findMany({
			where: {
				brand_name: brandName,
				status: 1,
				price: { gt: 0 }
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
			},
		});

		res.json(products);
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Failed to fetch products by brand' });
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


// Route for getting orders with pagination and filters
app.get('/api/orders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 200); // Default 25, max 200 per page
    const skip = (page - 1) * limit;

    // Filter parameters
    const status = req.query.status || null;
    const search = req.query.search || '';
    const poStatus = req.query.poStatus || null; // 'not_set', 'set', 'partial'
    const region = req.query.region || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const filterMode = req.query.filterMode || 'order'; // 'order' or 'items'
    const vendor = req.query.vendor || null; // vendor name for items filter
    const dateFilter = req.query.dateFilter || null; // 'today', 'yesterday', 'last7days'

    // Build where clause
    const where = {};

    // Status filter
    if (status) {
      where.status = status;
    }

    // Date filter (today, yesterday, last7days)
    // Note: created_at is stored as text in format "YYYY-MM-DD HH:MM:SS"
    if (dateFilter) {
      const now = new Date();
      const torontoFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });

      if (dateFilter === 'today') {
        const todayStr = torontoFormatter.format(now);
        where.created_at = { startsWith: todayStr };
      } else if (dateFilter === 'yesterday') {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayStr = torontoFormatter.format(yesterday);
        where.created_at = { startsWith: yesterdayStr };
      } else if (dateFilter === 'last7days') {
        const sevenDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
        const sevenDaysAgoStr = torontoFormatter.format(sevenDaysAgo);
        where.created_at = { gte: sevenDaysAgoStr };
      }
    }

    // Search and filter logic depends on filterMode
    if (filterMode === 'items') {
      // Items mode: search by SKU, product name, and filter by vendor
      const itemsFilter = {};

      // Search by SKU or product name
      if (search) {
        itemsFilter.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ];
      }

      // Filter by vendor (selected_supplier)
      if (vendor) {
        itemsFilter.selected_supplier = { equals: vendor, mode: 'insensitive' };
      }

      // Apply items filter if any conditions exist
      if (Object.keys(itemsFilter).length > 0) {
        where.items = { some: itemsFilter };
      }
    } else {
      // Order mode (default): search by order fields
      if (search) {
        where.OR = [
          { increment_id: { contains: search, mode: 'insensitive' } },
          { customer_firstname: { contains: search, mode: 'insensitive' } },
          { customer_lastname: { contains: search, mode: 'insensitive' } },
          { customer_email: { contains: search, mode: 'insensitive' } },
          { custom_po_number: { contains: search, mode: 'insensitive' } },
        ];
      }
    }

    // PO Status filter
    if (poStatus === 'not_set') {
      where.OR = [
        { custom_po_number: null },
        { custom_po_number: '' },
        { custom_po_number: { equals: 'not set', mode: 'insensitive' } },
      ];
    } else if (poStatus === 'set') {
      where.AND = [
        { custom_po_number: { not: null } },
        { custom_po_number: { not: '' } },
        { NOT: { custom_po_number: { equals: 'not set', mode: 'insensitive' } } },
        { NOT: { custom_po_number: { contains: 'not set', mode: 'insensitive' } } },
      ];
    } else if (poStatus === 'partial') {
      where.AND = [
        { custom_po_number: { contains: 'not set', mode: 'insensitive' } },
        { NOT: { custom_po_number: { equals: 'not set', mode: 'insensitive' } } },
      ];
    }

    // Region filter
    if (region) {
      where.region = region;
    }

    // Date range filter
    if (dateFrom || dateTo) {
      where.created_at = {};
      if (dateFrom) {
        where.created_at.gte = new Date(dateFrom);
      }
      if (dateTo) {
        where.created_at.lte = new Date(dateTo);
      }
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          items: {
            include: {
              product: {
                select: {
                  sku: true,
                  name: true,
                  price: true,
                  brand_name: true,
                  image: true,
                  weight: true,
                  shippingFreight: true,
                  url_path: true,
                  black_friday_sale: true,
                },
              },
            },
            where: {
              base_price: {
                gt: 0,
              },
            },
          },
        },
        orderBy: {
          created_at: 'desc',
        },
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        status,
        search,
        poStatus,
        region,
        dateFrom,
        dateTo,
        filterMode,
        vendor,
        dateFilter,
      },
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      error: `${error} Failed to fetch orders`,
    });
  }
});

// Route for getting order metrics (independent of pagination)
app.get('/api/orders/metrics', async (req, res) => {
  try {
    // Get current date in Toronto timezone
    // The created_at field is stored as a string in format "YYYY-MM-DD HH:MM:SS"
    // We need to use string comparison since it's not a proper timestamp
    const now = new Date();
    const torontoFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Get today's date in Toronto as YYYY-MM-DD format
    const todayStr = torontoFormatter.format(now); // "2026-01-27"

    // Calculate yesterday and 7 days ago
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = torontoFormatter.format(yesterday);

    const sevenDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = torontoFormatter.format(sevenDaysAgo);

    // Run all counts in parallel for performance
    // Using raw SQL since created_at is stored as text, not timestamp
    const [
      notSetCount,
      todayCount,
      yesterdayCount,
      last7DaysCount,
      pmNotSetCount,
      gwCount,
      totalCount
    ] = await Promise.all([
      // Not Set Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE custom_po_number IS NULL
        OR custom_po_number = ''
        OR LOWER(custom_po_number) = 'not set'
      `.then(result => Number(result[0]?.count || 0)),

      // Today's Orders - compare string dates (created_at starts with today's date)
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE created_at LIKE ${todayStr + '%'}
      `.then(result => Number(result[0]?.count || 0)),

      // Yesterday's Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE created_at LIKE ${yesterdayStr + '%'}
      `.then(result => Number(result[0]?.count || 0)),

      // Last 7 Days Orders - string comparison works for YYYY-MM-DD format
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE created_at >= ${sevenDaysAgoStr}
      `.then(result => Number(result[0]?.count || 0)),

      // PM Not Set Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE LOWER(custom_po_number) LIKE '%pm%'
        AND LOWER(custom_po_number) LIKE '%not set%'
      `.then(result => Number(result[0]?.count || 0)),

      // GW Orders
      prisma.$queryRaw`
        SELECT COUNT(*) as count FROM "Order"
        WHERE LOWER(custom_po_number) LIKE '%gw%'
      `.then(result => Number(result[0]?.count || 0)),

      // Total Orders
      prisma.order.count(),
    ]);

    res.json({
      notSetCount,
      todayCount,
      yesterdayCount,
      last7DaysCount,
      pmNotSetCount,
      gwCount,
      totalCount,
    });
  } catch (error) {
    console.error('Error fetching order metrics:', error);
    res.status(500).json({ error: 'Failed to fetch order metrics', details: error.message });
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

// Global error handler (Axiom)
app.use((err, req, res, next) => {
	logger.apiError(err, req);
	res.status(err.status || 500).json({
		error: process.env.NODE_ENV === 'production'
			? 'Internal Server Error'
			: err.message,
	});
});

// Graceful shutdown - disconnect Prisma and flush logs before exit
async function gracefulShutdown(signal) {
	logger.info(`${signal} received, shutting down gracefully`);
	try {
		await prisma.$disconnect();
		await logger.flush();
	} catch (e) {
		console.error('Error during shutdown:', e);
	}
	process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 🕐 Cron Job: Run seed-all daily at 1:00 AM (Toronto timezone)
cron.schedule('0 1 * * *', () => {
	const startTime = Date.now();
	logger.info('🕐 Cron job started: Running seed-all at 1:00 AM');
	console.log('🕐 [CRON] Starting daily seed-all at 1:00 AM...');
	
	const seedProcess = spawn('npm', ['run', 'seed-all'], {
		cwd: __dirname,
		stdio: 'inherit',
		shell: true
	});

	seedProcess.on('close', async (code) => {
		const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2) + ' minutes';
		
		if (code === 0) {
			logger.info('✅ Cron job completed: seed-all finished successfully', { duration });
			console.log('✅ [CRON] Daily seed-all completed successfully');
			
			// Send success email
			await sendCronNotification({
				jobName: 'Daily Vendor Sync (seed-all)',
				success: true,
				duration
			});
		} else {
			logger.error('❌ Cron job failed: seed-all exited with error', { exitCode: code, duration });
			console.error(`❌ [CRON] Daily seed-all failed with exit code ${code}`);
			
			// Send failure email
			await sendCronNotification({
				jobName: 'Daily Vendor Sync (seed-all)',
				success: false,
				exitCode: code,
				error: `Process exited with code ${code}`,
				duration
			});
		}
	});

	seedProcess.on('error', async (error) => {
		const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2) + ' minutes';
		logger.error('❌ Cron job error: Failed to start seed-all', { error: error.message, duration });
		console.error('❌ [CRON] Error running seed-all:', error.message);
		
		// Send error email
		await sendCronNotification({
			jobName: 'Daily Vendor Sync (seed-all)',
			success: false,
			error: error.message,
			duration
		});
	});
}, {
	scheduled: true,
	timezone: 'America/Toronto'
});

app.listen(PORT, () => {
	logger.info(`Server started on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV });
	console.log(
		`Express seems to be listening on port ${PORT} so that's pretty good 👍`
	);
	console.log('🕐 [CRON] Daily seed-all scheduled for 1:00 AM (Toronto timezone)');
	console.log('📧 [EMAIL] Notifications will be sent to:', process.env.CRON_NOTIFICATION_EMAIL || 'tsantos@justjeeps.com');
});
