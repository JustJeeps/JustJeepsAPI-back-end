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

// Configuração do connection pool baseada no ambiente
const getConnectionLimit = () => {
  // DigitalOcean Basic DB: ~25 conexões totais (muito limitado!)
  // Com DATABASE_URL já tendo connection_limit=5, não sobrescrevemos
  // API Server: 2 conexões (ultra conservador para prod)
  // Cada seed script: 2 conexões (permite até 5 scripts = 10 conexões)
  // Admin/migrations: reserva de ~5
  // Total usado: ~17 de 25 disponíveis
  
  if (process.env.NODE_ENV === 'production') {
    return 2; // MUITO reduzido - DigitalOcean Basic tem ~25 total
  }
  
  // Desenvolvimento: detecta se é um script de seed
  const isSeeding = process.argv.some(arg => 
    arg.includes('seed') || arg.includes('prisma/seeds')
  );
  
  return isSeeding ? 2 : 3; // Seeds e dev também reduzidos
};

// Adiciona connection_limit e pool_timeout à DATABASE_URL
const getDatabaseUrl = () => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  // Se já tem connection_limit, não modifica
  if (baseUrl.includes('connection_limit')) {
    return baseUrl;
  }

  // Adiciona connection_limit e pool_timeout
  const separator = baseUrl.includes('?') ? '&' : '?';
  const connectionLimit = getConnectionLimit();
  // pool_timeout em segundos (tempo máximo para aguardar conexão)
  return `${baseUrl}${separator}connection_limit=${connectionLimit}&pool_timeout=10`;
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

module.exports = prisma;
