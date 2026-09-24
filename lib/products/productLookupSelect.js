// The product projection behind the magnifier lookup on the Orders screen
// (GET /api/products/:sku in server.js). The Replacement Lookup reuses it so a
// replacement product shows exactly the same data as the original one would.
// Keep the two callers on this single definition.

const PRODUCT_LOOKUP_SELECT = {
	sku: true,
	name: true,
	url_path: true,
	status: true,
	price: true,
	MAP: true,
	replace_oe: true,
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
	black_friday_sale: true,
	weight: true,
	length: true,
	width: true,
	height: true,
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
			vendor_cost_usd: true,
			quadratec_shipping_surcharge_usd: true,
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
};

module.exports = { PRODUCT_LOOKUP_SELECT };
