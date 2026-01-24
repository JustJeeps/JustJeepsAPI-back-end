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
  // DigitalOcean Basic DB: ~25 conexões
  // Reservamos algumas para migrações e admin
  if (process.env.NODE_ENV === 'production') {
    return 10; // Limite conservador para produção
  }
  return 5; // Desenvolvimento local
};

// Adiciona connection_limit à DATABASE_URL se não existir
const getDatabaseUrl = () => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  // Se já tem connection_limit, não modifica
  if (baseUrl.includes('connection_limit')) {
    return baseUrl;
  }

  // Adiciona connection_limit
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}connection_limit=${getConnectionLimit()}`;
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

module.exports = prisma;
