// Papel efetivo de um usuario num setor e o que cada papel pode fazer.
// Politica (research Trello/ClickUp): triage global e o "workspace admin" do
// Trello — enxerga e gerencia todos os setores, sem opt-in. Modulo puro — o
// front tem espelho em requestsConstants.js, mas quem manda e esta regra,
// aplicada no servico.

const { SECTOR_ROLES } = require('../../config/sectors.js');

// 'triage' > 'admin' > 'member' > null. Role desconhecida gravada no banco
// degrada para member — nunca escala privilegio por dado sujo.
function roleFor({ membership, isTriage }) {
	if (isTriage === true) return 'triage';
	if (!membership) return null;
	return membership.role === 'admin' ? 'admin' : 'member';
}

function canManageSector({ role }) {
	return role === 'triage' || role === 'admin';
}

// Criar setor e exclusivo de triage (anti-sprawl — padrao dos dois produtos:
// restringir quem cria areas e o mecanismo contra proliferacao sem dono).
function canCreateSector({ isTriage }) {
	return isTriage === true;
}

// Mover chamado de setor: triage ou admin do setor de ORIGEM (quem cuida da
// fila decide o que sai dela).
function canMoveRequest({ isTriage, isSourceAdmin }) {
	return isTriage === true || isSourceAdmin === true;
}

// Abrir chamado num setor (2026-08-21): triage abre em qualquer um; nao-triage
// so no General (catch-all de quem nao sabe/nao pertence) ou em setor do qual
// e membro. Admin de setor e membro dele, entao a regra o cobre.
function canCreateRequestInSector({ isTriage, isDefaultSector, isMember }) {
	return isTriage === true || isDefaultSector === true || isMember === true;
}

// Slug estavel para o setor (chave de deep-link ?sector=). Colisao e tratada
// no servico com sufixo numerico.
function slugify(name) {
	return String(name || '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

module.exports = {
	SECTOR_ROLES,
	roleFor,
	canManageSector,
	canCreateSector,
	canCreateRequestInSector,
	canMoveRequest,
	slugify,
};
