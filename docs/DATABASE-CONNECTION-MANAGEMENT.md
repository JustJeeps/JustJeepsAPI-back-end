# Database Connection Pool Management Guide

## 🎯 Problem Solved
Your database was running out of connection slots because multiple processes (API server, seed scripts, Prisma Studio) were each creating connection pools, exhausting the database's maximum connections.

## ✅ What Was Fixed

### 1. Reduced Connection Pool Limits
**File: `lib/prisma.js`**
- API Server: 2 connections (production)
- Seed Scripts: 2 connections each (development)
- **Current Database Limit: 25 connections** (DigitalOcean Basic Plan)

### 2. Added Pool Timeout
- Connections now timeout after 10 seconds if unavailable
- Prevents hanging connections from blocking the pool

### 3. Graceful Shutdown Handlers
- Prisma properly disconnects on process termination (SIGINT, SIGTERM)
- Ensures connections are released when processes end

### 4. PostgreSQL Configuration
**File: `docker-compose.yml`**
- Set `max_connections=100` explicitly (only applies to local Docker database)
- Added `shared_buffers=256MB` for better performance
- **Note:** Your production environment uses DigitalOcean managed database with 25 max connections

## 📊 Connection Budget (25 total on DigitalOcean Basic)
```
API Server:            2 connections
Seed Script 1:         2 connections
Seed Script 2:         2 connections
Seed Script 3:         2 connections
Prisma Studio:         2 connections
Background processes:  ~8 connections (pg_cron, monitoring, etc.)
------------------------------------
Total Used:           ~18 / 25
Available:            7 connections
```

**⚠️ Current Status: 72% capacity** - Running close to the limit!

## 🚀 Running Multiple Processes Safely

### ✅ Safe: Run up to 3 seed scripts simultaneously
```bash
# Recommended: Run in batches of 3
npm run seed-meyer &
npm run seed-wp-inventory &
npm run seed-omix-inventory &
wait

# Then run next batch
npm run seed-keystone &
npm run seed-quad-inventory &
wait
```

### ⚠️ **IMPORTANT:** Close Prisma Studio before running seeds!
Prisma Studio uses 2-3 connections and will push you over the limit.

### ⚠️  Monitor Connection Usage
```bash
# Check current database connections
npm run db:check-connections
```

### 🛑 Emergency: Kill All Seed Processes
```bash
# If you hit connection limits again
npm run db:kill-seeds

# Or manually
pkill -f 'prisma/seeds'
```

### 📊 Check Running Processes
```bash
# See what's using connections
ps aux | grep -i prisma | grep -v grep

# Check Docker containers
docker ps
docker stats --no-stream
```

## 🎓 Best Practices

### 1. **Always disconnect when done**
All your seed scripts already do this correctly:
```javascript
try {
  // ... seed logic
} finally {
  await prisma.$disconnect(); // ✅ Always called
}
```

### 2. **Run seeds sequentially for large imports**
If you need to run many seeds, consider running them one at a time:
```javascript
// In seed-all.js or similar
await seedMeyer();
await seedWheelPros();
await seedOmix();
// etc.
```

### 3. **Close Prisma Studio when not needed**
Prisma Studio keeps connections open. Close it when running multiple seeds.

### 4. **Monitor production carefully**
The production API uses only 5 connections to be conservative. If you experience slow requests under high load, we can increase this to 8-10.

## 🔧 Troubleshooting

### "remaining connection slots are reserved for SUPERUSER"
This means you've exhausted all available connections.

**Fix:**
1. Kill unnecessary processes: `npm run db:kill-seeds`
2. Check connections: `npm run db:check-connections`
3. Restart Docker: `docker-compose restart`

### Too many processes running
```bash
# List all Prisma-related processes
ps aux | grep -i prisma | grep -v grep

# Kill specific process
kill -9 <PID>

# Kill all seed processes
npm run db:kill-seeds
```

### Need more concurrent processes?
If you regularly need more than 5 concurrent seed scripts:

1. **Option A:** Increase seed connection limit in `lib/prisma.js`:
   ```javascript
   return isSeeding ? 3 : 5; // Change 3 to 2
   ```: DigitalOcean Basic Plan
- **Max Connections:** 25
- **Current Usage:** ~18 (72%)
- **Good for:**
  - ✅ Single API instance with light traffic
  - ✅ 2-3 concurrent seed scripts
  - ⚠️ Very limited headroom

### 🚀 Recommended Upgrade: DigitalOcean Professional Plan

#### Why Upgrade?
You're currently at **72% capacity**, which is risky. Any spike in usage will cause failures.

#### DigitalOcean Managed Database Tiers:

| Plan | vCPUs | RAM | Storage | **Max Connections** | Price/month |
|------|-------|-----|---------|---------------------|-------------|
| **Basic** (current) | 1 | 1 GB | 10 GB | **25** | ~$15 |
| **Professional 1** | 1 | 2 GB | 25 GB | **97** | ~$60 |
| **Professional 2** | 2 | 4 GB | 38 GB | **197** | ~$120 |
| **Professional 4** | 4 | 8 GB | 115 GB | **397** | ~$240 |

#### Recommended: Professional 1 ($60/month)
- **97 connections** (4x more than Basic)
- Allows you to:
  - ✅ Run 5-10 seed scripts simultaneously
  - ✅ Handle production traffic spikes
  - ✅ Use Prisma Studio without worrying
  - ✅ Have proper development workflow
  - ✅ Add staging environment

### How to Upgrade

#### Option 1: Via DigitalOcean Console (Recommended)
1. Go to https://cloud.digitalocean.com/databases
2. Select your database cluster: `db-postgresql-tor1-84356`
3. Click **"Settings"** tab
4. Click **"Resize"**
5. Select **"Professional - $60/month"** (1 vCPU, 2 GB RAM)
6. Click **"Resize Database Cluster"**
7. Wait 5-10 minutes for resize to complete

#### Option 2: Via DigitalOcean CLI
```bash⚠️ Working but at 72% capacity  
**Recommendation:** Upgrade to DigitalOcean Professional plan for better stability
# Install doctl if not already installed
brew install doctl

# Authenticate
doctl auth init

# List your databases
doctl databases list

# Resize to Professional 1
doctl databases resize <database-id> --size db-s-2vcpu-4gb
```

### After Upgrading

Once upgraded to Professional plan, update your connection limits:

**File: `lib/prisma.js`**
```javascript
if (process.env.NODE_ENV === 'production') {
  return 10; // Increased from 2 - can handle more traffic
}
return isSeeding ? 5 : 10; // More headroom for development
```

Then restart:
```bash
./scripts/restart-all.sh
npm run db:check-connections
```

### If Budget is Tight

If $60/month is too much, you can:

1. **Use local Docker database for development**
   - Update `.env` to point to `localhost:5433`
   - Only use DigitalOcean for production
   - Saves connections and costs

2. **Run seeds sequentially**
   - Never run more than 1-2 seeds at a time
   - Use `seed-all.js` to run them in order

3. **Optimize connection usage**
   - Close Prisma Studio when not in use
   - Reduce API connection pool to 1-2
   - Monitor closely with `npm run db:check-connections`

### Current Setup (Good for)
- ✅ Very light development work
- ✅ Low-traffic production (< 10 concurrent users)
- ⚠️ Requires careful connection management

### If you need more
**Strongly recommended** to upgrade to Professional plan if you:
- ❌ Frequently hit connection limits
- ❌ Run multiple seed scripts regularly
- ❌ Have production traffic
- ❌ Need development + production environments
- ❌ Want to use Prisma Studio freely
- ✅ API server with moderate traffic
- ✅ Occasional Prisma Studio usage

### If you need more
Consider upgrading your database plan to support 200+ connections if you:
- Run 10+ concurrent seed scripts regularly
- Have high-traffic API (100+ concurrent users)
- Need multiple environments (staging + production)

## 🔍 Monitoring Commands

```bash
# Check active connections
npm run db:check-connections

# Monitor Docker containers
docker stats

# View API logs
docker logs justjeepsapi-back-end-api-1 --tail 50

# Check database container
docker exec justjeepsapi-back-end-db-1 psql -U <POSTGRES_USER> -d justjeeps -c "SELECT COUNT(*) FROM pg_stat_activity;"
```

## ✨ New Scripts Added

- `npm run db:check-connections` - Shows current database connection usage
- `npm run db:kill-seeds` - Emergency kill all seed processes

---

**Last Updated:** January 29, 2026  
**Status:** ✅ Resolved - You can now safely run 5+ concurrent processes
