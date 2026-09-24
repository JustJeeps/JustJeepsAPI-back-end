const test = require('node:test');
const assert = require('node:assert');

// Route-level test of routes/productReplacements.js: drives real HTTP through
// the router with a fake service, so it covers the 401 guard, payload shape
// validation, param parsing and the error mapping (409 with a code for
// business rules, never 403). No database: lib/prisma is stubbed before the
// router loads, and the router is built with an injected service.

const stub = (relativePath, exports) => {
	require.cache[require.resolve(relativePath)] = { id: relativePath, filename: relativePath, loaded: true, exports };
};
stub('../../lib/prisma', {});

const express = require('express');
const { createProductReplacementsRouter } = require('../../routes/productReplacements');
const { ProductReplacementError } = require('../../services/productReplacements/errors');

const USER = { id: 1, username: 'paula', email: 'paula@x', firstname: 'Paula', lastname: 'P' };

function makeFakeService() {
	const calls = [];
	const record = (name) => async (args) => {
		calls.push({ name, args });
		const behaviour = fake.next[name];
		if (behaviour instanceof Error) throw behaviour;
		return behaviour === undefined ? { ok: name } : behaviour;
	};
	const fake = {
		calls,
		next: {},
		listReplacements: record('listReplacements'),
		createReplacements: record('createReplacements'),
		removeReplacement: record('removeReplacement'),
		addComment: record('addComment'),
		removeComment: record('removeComment'),
		getReplacementsForSku: record('getReplacementsForSku'),
		countActiveBySkus: record('countActiveBySkus'),
		getProductBySku: record('getProductBySku'),
	};
	return fake;
}

const MANAGERS = ['ricardo', 'tess'];
// Rollout gate: only these people see and use the feature while it is tested.
const ALLOWED = ['admin', 'ricardo', 'paula', 'karoline'];
const isAllowed = (user) => ALLOWED.includes(String(user?.username || '').toLowerCase())
	|| ALLOWED.includes(String(user?.email || '').split('@')[0].toLowerCase());

function startServer({ service, user = USER }) {
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => { if (user) req.user = user; next(); });
	app.use('/api/product-replacements', createProductReplacementsRouter({
		service,
		managers: MANAGERS,
		isManager: (username) => MANAGERS.includes(String(username || '').toLowerCase()),
		isAllowedUser: isAllowed,
	}));
	return new Promise((resolve) => {
		const server = app.listen(0, () => resolve({ server, port: server.address().port }));
	});
}

const call = (port, method, url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
	method,
	headers: { 'content-type': 'application/json' },
	body: body === undefined ? undefined : JSON.stringify(body),
});

const withServer = async (options, fn) => {
	const { server, port } = await startServer(options);
	try {
		await fn(port);
	} finally {
		server.close();
	}
};

test('every route answers 401 without a logged in user', async () => {
	const service = makeFakeService();
	await withServer({ service, user: null }, async (port) => {
		const response = await call(port, 'GET', '/api/product-replacements');
		assert.strictEqual(response.status, 401);
		assert.strictEqual(service.calls.length, 0);
	});
});

test('GET / lists the directory with the search term', async () => {
	const service = makeFakeService();
	service.next.listReplacements = { groups: [], total: 0 };
	await withServer({ service }, async (port) => {
		const response = await call(port, 'GET', '/api/product-replacements?search=crown');
		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(await response.json(), { groups: [], total: 0 });
		assert.deepStrictEqual(service.calls[0], { name: 'listReplacements', args: { search: 'crown' } });
	});
});

test('POST / creates a batch for the logged in user and answers 201', async () => {
	const service = makeFakeService();
	service.next.createReplacements = [{ id: 1 }];
	await withServer({ service }, async (port) => {
		const response = await call(port, 'POST', '/api/product-replacements', {
			source_sku: 'CRO-83503077',
			replacements: [{ replacement_sku: 'MOO-RK620185', comment: 'Customer approval is required.' }],
		});
		const text = await response.text();
		assert.strictEqual(response.status, 201, text);
		assert.deepStrictEqual(JSON.parse(text), [{ id: 1 }]);
		assert.deepStrictEqual(service.calls[0], {
			name: 'createReplacements',
			args: {
				user: USER,
				source_sku: 'CRO-83503077',
				replacements: [{ replacement_sku: 'MOO-RK620185', comment: 'Customer approval is required.' }],
			},
		});
	});
});

test('POST / rejects a payload whose replacements is not a list', async () => {
	const service = makeFakeService();
	await withServer({ service }, async (port) => {
		const response = await call(port, 'POST', '/api/product-replacements', { source_sku: 'A', replacements: 'B' });
		assert.strictEqual(response.status, 400);
		assert.strictEqual((await response.json()).code, 'VALIDATION');
		assert.strictEqual(service.calls.length, 0);
	});
});

test('a business rule violation comes back as 409 with its code, never 403', async () => {
	const service = makeFakeService();
	service.next.createReplacements = ProductReplacementError.conflict('DUPLICATE_REPLACEMENT', 'already registered');
	await withServer({ service }, async (port) => {
		const response = await call(port, 'POST', '/api/product-replacements', { source_sku: 'A', replacements: [{ replacement_sku: 'B' }] });
		assert.strictEqual(response.status, 409);
		assert.deepStrictEqual(await response.json(), { error: 'already registered', code: 'DUPLICATE_REPLACEMENT' });
	});
});

test('an unexpected error is a generic 500', async () => {
	const service = makeFakeService();
	service.next.listReplacements = new Error('boom');
	const originalError = console.error;
	console.error = () => {};
	try {
		await withServer({ service }, async (port) => {
			const response = await call(port, 'GET', '/api/product-replacements');
			assert.strictEqual(response.status, 500);
			assert.deepStrictEqual(await response.json(), { error: 'Internal server error' });
		});
	} finally {
		console.error = originalError;
	}
});

test('DELETE /:id validates the id and soft deletes through the service', async () => {
	const service = makeFakeService();
	await withServer({ service }, async (port) => {
		assert.strictEqual((await call(port, 'DELETE', '/api/product-replacements/abc')).status, 400);
		assert.strictEqual(service.calls.length, 0);
		const response = await call(port, 'DELETE', '/api/product-replacements/12');
		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(service.calls[0], { name: 'removeReplacement', args: { user: USER, id: 12 } });
	});
});

test('comments: POST /:id/comments answers 201 and DELETE /:id/comments/:commentId answers 200', async () => {
	const service = makeFakeService();
	await withServer({ service }, async (port) => {
		const created = await call(port, 'POST', '/api/product-replacements/12/comments', { body: 'Same product, different manufacturer.' });
		assert.strictEqual(created.status, 201);
		assert.deepStrictEqual(service.calls[0], { name: 'addComment', args: { user: USER, id: 12, body: 'Same product, different manufacturer.' } });

		const removed = await call(port, 'DELETE', '/api/product-replacements/12/comments/34');
		assert.strictEqual(removed.status, 200);
		assert.deepStrictEqual(service.calls[1], { name: 'removeComment', args: { user: USER, id: 12, commentId: 34 } });
	});
});

test('GET /for-sku/:sku decodes the SKU and returns the lookup', async () => {
	const service = makeFakeService();
	service.next.getReplacementsForSku = { source_sku: 'OMX-18282.05', sourceProduct: null, replacements: [] };
	await withServer({ service }, async (port) => {
		const response = await call(port, 'GET', `/api/product-replacements/for-sku/${encodeURIComponent('OMX-18282.05')}`);
		assert.strictEqual(response.status, 200);
		assert.strictEqual((await response.json()).source_sku, 'OMX-18282.05');
		assert.deepStrictEqual(service.calls[0], { name: 'getReplacementsForSku', args: { sku: 'OMX-18282.05' } });
	});
});

test('GET /counts splits the comma separated skus and wraps the result', async () => {
	const service = makeFakeService();
	service.next.countActiveBySkus = { 'CRO-83503077': 2 };
	await withServer({ service }, async (port) => {
		const response = await call(port, 'GET', '/api/product-replacements/counts?skus=CRO-83503077,%20RUG-11540.11,');
		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(await response.json(), { counts: { 'CRO-83503077': 2 } });
		assert.deepStrictEqual(service.calls[0], { name: 'countActiveBySkus', args: { skus: ['CRO-83503077', 'RUG-11540.11'] } });
		const empty = await call(port, 'GET', '/api/product-replacements/counts');
		assert.deepStrictEqual(await empty.json(), { counts: {} });
	});
});

test('GET /meta tells the frontend whether the feature is enabled for the caller and whether they manage it', async () => {
	const service = makeFakeService();
	await withServer({ service }, async (port) => {
		const paula = await call(port, 'GET', '/api/product-replacements/meta');
		assert.strictEqual(paula.status, 200);
		assert.deepStrictEqual(await paula.json(), { enabled: true, isManager: false, managers: MANAGERS });
		assert.strictEqual(service.calls.length, 0);
	});
	await withServer({ service, user: { ...USER, username: 'Tess', email: 'tess@x' } }, async (port) => {
		const tess = await call(port, 'GET', '/api/product-replacements/meta');
		// Tess manages removals but is not in the rollout list: hidden for her.
		assert.deepStrictEqual(await tess.json(), { enabled: false, isManager: true, managers: MANAGERS });
	});
	await withServer({ service, user: { id: 9, username: 'someone', email: 'karoline@justjeeps.com' } }, async (port) => {
		const byEmail = await call(port, 'GET', '/api/product-replacements/meta');
		assert.strictEqual((await byEmail.json()).enabled, true, 'the email local part also opens the gate');
	});
});

test('every route except /meta answers 409 REPLACEMENTS_RESTRICTED outside the rollout list (never 403)', async () => {
	const service = makeFakeService();
	await withServer({ service, user: { ...USER, username: 'tess', email: 'tess@x' } }, async (port) => {
		const checks = [
			['GET', '/api/product-replacements'],
			['GET', '/api/product-replacements/counts?skus=A'],
			['GET', '/api/product-replacements/for-sku/A'],
			['GET', '/api/product-replacements/products/A'],
			['POST', '/api/product-replacements', { source_sku: 'A', replacements: [{ replacement_sku: 'B' }] }],
			['DELETE', '/api/product-replacements/1'],
			['POST', '/api/product-replacements/1/comments', { body: 'x' }],
			['DELETE', '/api/product-replacements/1/comments/2'],
		];
		for (const [method, url, body] of checks) {
			const response = await call(port, method, url, body);
			assert.strictEqual(response.status, 409, `${method} ${url}`);
			assert.strictEqual((await response.json()).code, 'REPLACEMENTS_RESTRICTED', `${method} ${url}`);
		}
		assert.strictEqual(service.calls.length, 0, 'the service is never reached');
	});
});

test('GET /products/:sku returns the merged product preview, 404 when unknown', async () => {
	const service = makeFakeService();
	service.next.getProductBySku = { sku: 'OMX-18282.05', name: 'Omix', description: 'Live text', source: 'magento' };
	await withServer({ service }, async (port) => {
		const response = await call(port, 'GET', `/api/product-replacements/products/${encodeURIComponent('OMX-18282.05')}`);
		assert.strictEqual(response.status, 200);
		assert.strictEqual((await response.json()).description, 'Live text');
		assert.deepStrictEqual(service.calls[0], { name: 'getProductBySku', args: { sku: 'OMX-18282.05' } });
	});
	service.next.getProductBySku = null;
	await withServer({ service }, async (port) => {
		const response = await call(port, 'GET', '/api/product-replacements/products/NOPE');
		assert.strictEqual(response.status, 404);
		assert.strictEqual((await response.json()).code, 'SKU_NOT_FOUND');
	});
});

test('GET / caps the search term at 100 characters', async () => {
	const service = makeFakeService();
	service.next.listReplacements = { groups: [], total: 0 };
	await withServer({ service }, async (port) => {
		const response = await call(port, 'GET', `/api/product-replacements?search=${'a'.repeat(150)}`);
		assert.strictEqual(response.status, 400);
		assert.strictEqual((await response.json()).code, 'VALIDATION');
		assert.strictEqual(service.calls.length, 0);
	});
});

test('POST / accepts the "no replacement" shape without a replacements list', async () => {
	const service = makeFakeService();
	service.next.createReplacements = [{ id: 5, kind: 'none' }];
	await withServer({ service }, async (port) => {
		const response = await call(port, 'POST', '/api/product-replacements', { source_sku: 'CRO-83503077', no_replacement: true, comment: 'Discontinued.' });
		const text = await response.text();
		assert.strictEqual(response.status, 201, text);
		assert.deepStrictEqual(service.calls[0], {
			name: 'createReplacements',
			args: { user: USER, source_sku: 'CRO-83503077', replacements: [], no_replacement: true, comment: 'Discontinued.' },
		});
	});
});
