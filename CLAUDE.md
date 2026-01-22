# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run dev          # Start dev server with nodemon (hot-reload)
npm start            # Start production server
npx prisma studio    # Open Prisma Studio (browser-based DB UI)
```

### Docker Development
```bash
# First time setup
cp .env.example .env                    # Copy and configure environment variables
docker compose up -d                     # Start all services

# Development with hot-reload
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# View logs
docker compose logs -f api

# Stop services
docker compose down
```

### Database Setup
```bash
npx prisma generate           # Generate Prisma client after schema changes
npx prisma migrate dev        # Run migrations in development
npx prisma migrate deploy     # Run migrations in production
```

### Data Seeding
```bash
npm run seed-hard-code        # Seed vendors, users, competitors (essential data)
npm run seed-users            # Seed user accounts only
npm run seed-all              # Comprehensive seeding (all products)
npm run seed-orders           # Seed order data
```

Individual vendor seeders: `seed-meyer`, `seed-keystone`, `seed-omix`, `seed-quadratec`, `seed-aev`, `seed-turn14-production`, `seed-daily-premier`, `seed-metalcloak`, `seed-roughCountry`, `seed-wheelPros`, etc.

## Architecture

### Entry Point
`server.js` - Monolithic Express application containing all route definitions, middleware setup, and API endpoints.

### Directory Structure
```
server.js                    # Express app with all routes
routes/auth.js               # Authentication endpoints (separated)
middleware/auth.js           # JWT verification & feature flag middleware
schema.prisma                # Database schema
services/
  ├── turn14/                # Turn14 API integration
  ├── premier/               # Premier API integration
  └── metalcloak/            # MetalCloak API integration
prisma/seeds/
  ├── hard-code_data/        # Static reference data (vendors, users, competitors)
  ├── seed-individual/       # 40+ vendor-specific seeders
  ├── api-calls/             # API integration scripts
  └── scrapping/             # Web scraping scripts (metalcloak, stinger)
```

### Tech Stack
- **Runtime**: Node.js + Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: JWT tokens with bcryptjs, feature-flag controlled (`ENABLE_AUTH`)
- **Data Processing**: CSV/Excel parsing, XML parsing, web scraping (Puppeteer), FTP transfers

### Key Patterns
- **Feature Flags**: Authentication disabled by default (`ENABLE_AUTH=false`) for zero-downtime deployment
- **Vendor Integrations**: 13+ vendors via APIs, FTP, CSV imports, and web scraping
- **Multi-source Products**: Products have vendor-specific codes (`meyer_code`, `keystone_code`, `t14_code`, `premier_code`, etc.)

## Environment Variables

Copy `.env.example` to `.env` and configure your values. See `SECURITY.md` for best practices.

**Required variables:**
- `POSTGRES_USER` - Database username
- `POSTGRES_PASSWORD` - Database password (use strong passwords)
- `JWT_SECRET` - Secret key for JWT tokens (min 32 chars, see SECURITY.md)

**Optional variables:**
- `POSTGRES_DB` - Database name (default: justjeeps)
- `PORT` - API port (default: 8080)
- `ENABLE_AUTH` - Enable JWT authentication (default: false)
- `JWT_EXPIRES_IN` - Token expiration (default: 24h)
- `MAGENTO_KEY` - Magento API key for integration

**Generate a secure JWT secret:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## API Structure

### Core Endpoints
- `GET /api/products` - Products with vendor/competitor info
- `GET /api/orders` - Orders with items
- `GET /api/vendors` - All vendors
- `GET /api/vendor_products` - Product-vendor mappings with costs/inventory
- `GET /api/purchase_orders` - Purchase orders

### Authentication (when enabled)
- `POST /api/auth/login` - Login (username/email + password)
- `POST /api/auth/register` - Create account
- `GET /api/auth/status` - Check if auth enabled
- `GET /api/auth/me` - Current user (requires token)

### Test Users (after `npm run seed-users`)
- admin / adminpassword
- johndoe / mypassword1

## Database

Core models: `Product`, `Order`, `OrderProduct`, `Vendor`, `VendorProduct`, `PurchaseOrder`, `PurchaseOrderLineItem`, `User`, `Competitor`, `CompetitorProduct`

Products contain 20,000+ SKUs with multi-vendor support. Schema has 50+ migrations tracking evolution.

## Security

See `SECURITY.md` for complete security documentation.

**Key points:**
- Never commit `.env` files (use `.env.example` as template)
- Use strong, unique passwords for all environments
- Enable `ENABLE_AUTH=true` in production
- Rotate secrets after team changes or suspected breaches
- Run `npm audit` regularly to check for vulnerabilities
