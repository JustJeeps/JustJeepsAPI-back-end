const express = require('express');

const prisma = require('../lib/prisma');

const router = express.Router();

// Guard proprio (mesmo contrato dos outros routers da feature): um deploy com
// ENABLE_AUTH errado deixaria o middleware global sem popular req.user e o
// diretorio inteiro exposto a chamada anonima. Nao usa o rollout gate de
// requests de proposito: a tabela usuario->board do /settings (Trello) tambem
// consome esta rota e tem outro eixo de permissao.
router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Access token required' });
	}
	next();
});

// GET /api/users — lista enxuta para popular selects (assignee de requests).
// Select explicito: nunca expor password.
router.get('/', async (req, res) => {
	try {
		const users = await prisma.user.findMany({
			select: { id: true, username: true, email: true, firstname: true, lastname: true },
			orderBy: [{ firstname: 'asc' }, { username: 'asc' }],
		});
		res.json(users);
	} catch (error) {
		console.error('Users list error:', error);
		res.status(500).json({ error: 'Failed to list users' });
	}
});

module.exports = router;
