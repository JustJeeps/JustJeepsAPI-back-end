#!/usr/bin/env node

/**
 * Database Connection Monitor
 * 
 * This script checks how many connections are active to the PostgreSQL database.
 * Run this to diagnose connection pool exhaustion issues.
 * 
 * Usage:
 *   node scripts/check-db-connections.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkConnections() {
  try {
    console.log('🔍 Checking database connections...\n');

    // Query PostgreSQL to see active connections
    const connections = await prisma.$queryRaw`
      SELECT 
        datname as database,
        usename as user,
        application_name,
        client_addr,
        state,
        query_start,
        state_change,
        COUNT(*) OVER() as total_connections,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
      FROM pg_stat_activity
      WHERE datname = current_database()
      ORDER BY query_start DESC;
    `;

    const totalConnections = Number(connections[0]?.total_connections || 0);
    const maxConnections = Number(connections[0]?.max_connections || 0);

    console.log(`📊 Connection Summary:`);
    console.log(`   Active: ${totalConnections} / ${maxConnections} max`);
    console.log(`   Available: ${maxConnections - totalConnections}\n`);

    // Group by application/state
    const byApp = connections.reduce((acc, conn) => {
      const key = conn.application_name || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    console.log(`📱 By Application:`);
    Object.entries(byApp).forEach(([app, count]) => {
      console.log(`   ${app}: ${count}`);
    });

    const byState = connections.reduce((acc, conn) => {
      acc[conn.state] = (acc[conn.state] || 0) + 1;
      return acc;
    }, {});

    console.log(`\n🔄 By State:`);
    Object.entries(byState).forEach(([state, count]) => {
      console.log(`   ${state}: ${count}`);
    });

    // Warning if too many connections
    const usagePercent = (totalConnections / maxConnections) * 100;
    if (usagePercent > 80) {
      console.log(`\n⚠️  WARNING: Database is at ${usagePercent.toFixed(1)}% capacity!`);
      console.log(`   Consider reducing concurrent processes or increasing max_connections.`);
    } else if (usagePercent > 60) {
      console.log(`\n⚠️  CAUTION: Database is at ${usagePercent.toFixed(1)}% capacity.`);
    } else {
      console.log(`\n✅ Connection usage is healthy (${usagePercent.toFixed(1)}%)`);
    }

  } catch (error) {
    console.error('❌ Error checking connections:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkConnections();
