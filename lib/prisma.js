/**
 * Prisma Client Singleton
 *
 * This module exports a single PrismaClient instance for the whole application.
 * That avoids the problem of multiple database connections.
 *
 * IMPORTANT: Always import prisma from this file, never create a new PrismaClient() directly.
 *
 * Usage:
 *   const prisma = require('./lib/prisma');
 *   // or
 *   const prisma = require('../lib/prisma');
 */

const { PrismaClient } = require('@prisma/client');

// Pool sized per process role. Measured in production (July 2026): the managed
// Postgres has max_connections=100 with about 19 in use, so the old assumption
// of "~25 total connections" was wrong and capped the API at 2 connections.
// Budget: api(10) + worker(12) + up to 2 concurrent seeds(4 each) +
// headroom for migrations and pg-boss, about 55 out of 100.
const ROLE_POOL_DEFAULTS = { api: 10, worker: 12, seed: 4 };

const detectRole = () => {
  const explicit = String(process.env.APP_ROLE || '').toLowerCase();
  if (ROLE_POOL_DEFAULTS[explicit] !== undefined) return explicit;

  // Fallback for processes without APP_ROLE (manual scripts): heuristic on argv
  const isSeeding = process.argv.some(arg =>
    arg.includes('seed') || arg.includes('prisma/seeds')
  );
  return isSeeding ? 'seed' : 'api';
};

const getConnectionLimit = () => {
  const role = detectRole();

  // Explicit override per env (e.g. DB_POOL_SEED=2 to run many in parallel)
  const override = Number(process.env[`DB_POOL_${role.toUpperCase()}`]);
  if (Number.isFinite(override) && override > 0) return override;

  if (process.env.NODE_ENV !== 'production') {
    return role === 'seed' ? 2 : 3; // dev: conservative
  }

  return ROLE_POOL_DEFAULTS[role];
};

// Forces the computed connection_limit/pool_timeout into DATABASE_URL. Whatever
// the URL carries is always overwritten: the source of truth for sizing is the
// process role (APP_ROLE) plus the DB_POOL_* overrides, never a parameter
// fossilized in the URL.
const getDatabaseUrl = () => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const url = new URL(baseUrl);
  url.searchParams.set('connection_limit', String(getConnectionLimit()));
  if (!url.searchParams.has('pool_timeout')) {
    // pool_timeout in seconds (maximum time to wait for a connection)
    url.searchParams.set('pool_timeout', '10');
  }
  return url.toString();
};

// Singleton pattern: reuses the existing instance in development (hot reload)
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

// In development, store it on the global object so it survives hot reload
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Graceful shutdown: releases connections when the process exits
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
