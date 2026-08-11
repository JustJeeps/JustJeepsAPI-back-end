// Definicoes centrais dos Setores (boards por setor da feature Requests):
// papeis, setor default e paleta de cores.
//
// IMPORTANTE: este modulo precisa continuar "puro" — apenas process.env e
// dados literais (mesma regra do config/requests.js), para que possa ser
// carregado por testes e scripts de validacao sem subir o servidor.

// Papeis validos em SectorMember.role (String validada, sem enum — padrao do
// repo, prisma/schema.prisma:257-261).
const SECTOR_ROLES = ['admin', 'member'];
const DEFAULT_SECTOR_ROLE = 'member';

// Setor semeado pela migration 20260811120000_add_sectors. Nao pode ser
// arquivado: e o destino de chamados criados sem setor (front antigo).
const DEFAULT_SECTOR_SLUG = 'general';

// Paleta oferecida no seletor de cor do setor (mesma familia dos status de
// config/requests.js).
const SECTOR_COLORS = [
	'#a855f7',
	'#0b8ce9',
	'#f97316',
	'#10a35a',
	'#fbbf24',
	'#ef4444',
	'#2563eb',
	'#1a8c5c',
];

const SECTOR_NAME_MAX_LENGTH = 60;

module.exports = {
	SECTOR_ROLES,
	DEFAULT_SECTOR_ROLE,
	DEFAULT_SECTOR_SLUG,
	SECTOR_COLORS,
	SECTOR_NAME_MAX_LENGTH,
};
