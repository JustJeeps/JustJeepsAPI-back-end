# JustJeeps API Backend

RESTful API backend for the JustJeeps automotive parts e-commerce platform.

## Tech Stack

- **Runtime**: Node.js 20+ / Express.js
- **Database**: PostgreSQL 14+ / Prisma ORM
- **Authentication**: JWT with feature flags
- **Deployment**: Docker / Kamal
- **Monitoring**: Axiom

## Quick Start

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

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | - |
| `PORT` | Server port | 8080 |
| `ENABLE_AUTH` | Enable JWT authentication | false |
| `JWT_SECRET` | Secret for JWT signing | - |
| `JWT_EXPIRES_IN` | Token expiration | 24h |

See `.env.example` for vendor API keys and other variables.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot-reload |
| `npm start` | Start production server |
| `npm run seed-hard-code` | Seed vendors, users, competitors |
| `npm run seed-users` | Seed user accounts |
| `npm run seed-orders` | Seed order data |
| `npx prisma studio` | Open database browser |

## API Endpoints

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check (used by load balancer) |

### Core Resources

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | List products with vendor info |
| GET | `/api/orders` | List orders with items |
| GET | `/api/vendors` | List all vendors |
| GET | `/api/vendor_products` | Product-vendor mappings |
| GET | `/api/purchase_orders` | Purchase orders |

### Authentication

Authentication is controlled by the `ENABLE_AUTH` feature flag.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Check if auth is enabled |
| POST | `/api/auth/login` | Login with username/password |
| POST | `/api/auth/register` | Create new account |
| GET | `/api/auth/me` | Get current user (requires token) |
| POST | `/api/auth/logout` | Logout user |

**Login Request:**
```json
{
  "username": "admin",
  "password": "yourpassword"
}
```

**Login Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com"
  }
}
```

**Using the token:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8080/api/auth/me
```

## Project Structure

```
├── server.js              # Main Express application
├── lib/
│   └── prisma.js          # Database client singleton
├── routes/
│   └── auth.js            # Authentication routes
├── middleware/
│   └── auth.js            # JWT middleware
├── services/              # External API integrations
│   ├── metalcloak/
│   ├── turn14/
│   └── premier/
├── utils/
│   └── logger.js          # Axiom logging utility
├── prisma/
│   ├── schema.prisma      # Database schema
│   └── seeds/             # Data seeding scripts
│       ├── hard-code_data/
│       ├── seed-individual/
│       ├── api-calls/
│       └── scrapping/
├── config/
│   └── deploy.yml         # Kamal deployment config
└── docs/
    ├── prd/               # Product Requirements Documents
    └── design/            # Design Documents
```

## Authentication System

### Feature Flag Design

- **Safe Default**: Auth disabled by default (`ENABLE_AUTH=false`)
- **Zero-downtime**: Enable without breaking existing functionality
- **Backward Compatible**: All endpoints work with or without auth

### Enabling Authentication

```bash
# 1. Set environment variable
ENABLE_AUTH=true

# 2. Ensure JWT_SECRET is configured
JWT_SECRET=your-secure-secret-min-32-chars

# 3. Seed test users
npm run seed-users

# 4. Restart server
npm run dev
```

### Security Features

- bcryptjs password hashing (10 salt rounds)
- JWT tokens with configurable expiration
- Bearer token authentication
- Feature flag protection

## Deployment

### Using Kamal

```bash
# First deployment
kamal setup

# Subsequent deployments
kamal deploy

# View logs
kamal app logs -f

# Run command in container
kamal app exec -- npm run seed-hard-code

# Access shell
kamal app exec -i -- sh
```

### Environment Setup

1. Copy `.env.production.example` to `.env.production`
2. Configure all required variables
3. Export variables before deploy:
   ```bash
   source .env.production
   kamal deploy
   ```

## Monitoring

Logs are sent to Axiom for centralized monitoring.

```bash
# Configure Axiom
AXIOM_TOKEN=your-token
AXIOM_DATASET=justjeeps-api
```

View logs at: https://app.axiom.co

## Troubleshooting

### Database Connection Failed

1. Verify `DATABASE_URL` is correct
2. Ensure `?sslmode=require` for managed databases
3. Check IP allowlist in database settings

### Auth Always Disabled

1. Verify `ENABLE_AUTH=true` in environment
2. Restart the server after changing
3. Check: `node -e "require('dotenv').config(); console.log(process.env.ENABLE_AUTH)"`

### Health Check Failing

1. Verify database is accessible
2. Check logs: `kamal app logs`
3. Test locally: `curl http://localhost:8080/api/health`

## Documentation

- [Security Guidelines](./SECURITY.md)
- [Deployment Guide](./DEPLOY.md)
- [PRDs](./docs/prd/)
- [Design Documents](./docs/design/)

## License

Proprietary - All rights reserved.
