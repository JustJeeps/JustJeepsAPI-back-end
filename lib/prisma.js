/**
 * Prisma Client Singleton
 *
 * Este módulo exporta uma única instância do PrismaClient para toda a aplicação.
 * Isso evita o problema de múltiplas conexões de banco de dados.
 *
 * IMPORTANTE: Sempre importe o prisma deste arquivo, nunca crie new PrismaClient() diretamente.
 *
 * Uso:
 *   const prisma = require('./lib/prisma');
 *   // ou
 *   const prisma = require('../lib/prisma');
 */

const { PrismaClient } = require('@prisma/client');

// Pool por papel do processo. Medido em produção (jul/2026): o Postgres
// gerenciado tem max_connections=100 com ~19 em uso — a premissa antiga de
// "~25 conexões totais" estava errada e limitava a API a 2 conexões.
// Orçamento: api(10) + worker(12) + até 2 seeds simultâneos(4 cada) +
// reserva p/ migrations e pg-boss ≈ 55 de 100.
const ROLE_POOL_DEFAULTS = { api: 10, worker: 12, seed: 4 };

const detectRole = () => {
  const explicit = String(process.env.APP_ROLE || '').toLowerCase();
  if (ROLE_POOL_DEFAULTS[explicit] !== undefined) return explicit;

  // Fallback p/ processos sem APP_ROLE (scripts manuais): heurística por argv
  const isSeeding = process.argv.some(arg =>
    arg.includes('seed') || arg.includes('prisma/seeds')
  );
  return isSeeding ? 'seed' : 'api';
};

const getConnectionLimit = () => {
  const role = detectRole();

  // Override explícito por env (ex.: DB_POOL_SEED=2 para rodar muitos em paralelo)
  const override = Number(process.env[`DB_POOL_${role.toUpperCase()}`]);
  if (Number.isFinite(override) && override > 0) return override;

  if (process.env.NODE_ENV !== 'production') {
    return role === 'seed' ? 2 : 3; // dev: conservador
  }

  return ROLE_POOL_DEFAULTS[role];
};

// Força connection_limit/pool_timeout calculados na DATABASE_URL. O valor da
// URL é sempre sobrescrito: a fonte de verdade do sizing é o papel do processo
// (APP_ROLE) + os overrides DB_POOL_*, nunca um parâmetro fossilizado na URL.
const getDatabaseUrl = () => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const url = new URL(baseUrl);
  url.searchParams.set('connection_limit', String(getConnectionLimit()));
  if (!url.searchParams.has('pool_timeout')) {
    // pool_timeout em segundos (tempo máximo para aguardar conexão)
    url.searchParams.set('pool_timeout', '10');
  }
  return url.toString();
};

// Singleton pattern - reutiliza instância existente em desenvolvimento (hot reload)
const globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: getDatabaseUrl(),
    },
  },
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

// Em desenvolvimento, armazena no global para sobreviver ao hot reload
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Graceful shutdown - libera conexões quando o processo termina
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGUSR2', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = prisma;
