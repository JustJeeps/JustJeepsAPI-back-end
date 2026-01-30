#!/bin/bash

# Full restart script to clear all database connections
# Use this when experiencing connection pool exhaustion

echo "🔄 Full Application Restart"
echo "================================"

# 1. Kill all local seed processes
echo "1️⃣  Killing seed processes..."
pkill -9 -f 'prisma/seeds' 2>/dev/null || true
pkill -9 -f 'prisma studio' 2>/dev/null || true
sleep 2

# 2. Stop Docker containers
echo "2️⃣  Stopping Docker containers..."
docker-compose down

# 3. Wait for connections to clear
echo "3️⃣  Waiting for database connections to clear..."
sleep 5

# 4. Start Docker containers
echo "4️⃣  Starting Docker containers..."
docker-compose up -d

# 5. Wait for API to be ready
echo "5️⃣  Waiting for API to start..."
sleep 10

# 6. Check status
echo "6️⃣  Checking container status..."
docker ps

echo ""
echo "✅ Restart complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 To monitor connections: npm run db:check-connections"
echo "📋 To view logs: docker logs justjeepsapi-back-end-api-1 --tail 50"
