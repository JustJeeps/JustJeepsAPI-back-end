# JustJeeps API Backend

RESTful API backend for the JustJeeps automotive parts e-commerce platform.

## Tech Stack

- **Runtime**: Node.js + Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: JWT with feature flags
- **Deployment**: Docker + Kamal
- **Monitoring**: Axiom (logging & error tracking)

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Docker (for production deployment)

### Development Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev

# Seed essential data
npm run seed-hard-code

# Start development server
npm run dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Server port (default: 8080) |
| `JWT_SECRET` | Secret for JWT signing |
| `ENABLE_AUTH` | Enable authentication (default: false) |

See `.env.example` for full list of available variables.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot-reload |
| `npm start` | Start production server |
| `npm run seed-hard-code` | Seed vendors, users, competitors |
| `npm run seed-orders` | Seed order data |
| `npx prisma studio` | Open database browser |

## API Endpoints

### Core Resources

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/products` | List products |
| GET | `/api/orders` | List orders |
| GET | `/api/vendors` | List vendors |
| GET | `/api/vendor_products` | Product-vendor mappings |

### Authentication (when enabled)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | User login |
| POST | `/api/auth/register` | User registration |
| GET | `/api/auth/status` | Auth status check |
| GET | `/api/auth/me` | Current user info |

## Project Structure

```
├── server.js           # Main Express application
├── lib/
│   └── prisma.js       # Database client singleton
├── routes/
│   └── auth.js         # Authentication routes
├── middleware/
│   └── auth.js         # JWT middleware
├── services/           # External API integrations
├── utils/
│   └── logger.js       # Axiom logging utility
├── prisma/
│   ├── schema.prisma   # Database schema
│   └── seeds/          # Data seeding scripts
└── config/
    └── deploy.yml      # Kamal deployment config
```

## Deployment

This project uses [Kamal](https://kamal-deploy.org/) for Docker-based deployments.

```bash
# Deploy to production
kamal deploy

# View logs
kamal app logs

# Run console
kamal app exec -i sh
```

## Documentation

- [Authentication Guide](./README-AUTHENTICATION.md)
- [Security Guidelines](./SECURITY.md)
- [API Documentation](./docs/)

## License

Proprietary - All rights reserved.
