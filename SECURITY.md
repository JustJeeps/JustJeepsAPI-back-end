# Security Best Practices

This document outlines the security measures and best practices implemented in the JustJeeps API.

## Environment Variables

### Setup

1. **Copy the template file:**
   ```bash
   cp .env.example .env
   ```

2. **Generate a secure JWT secret:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

3. **Fill in all required variables** in `.env` with your secure values.

### Required Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `POSTGRES_USER` | Database username | Yes |
| `POSTGRES_PASSWORD` | Database password | Yes |
| `POSTGRES_DB` | Database name | No (default: justjeeps) |
| `JWT_SECRET` | Secret key for JWT tokens (min 32 chars) | Yes |
| `MAGENTO_KEY` | Magento API key | For Magento integration |

### Security Rules

- **NEVER** commit `.env` files to version control
- **NEVER** share secrets in Slack, email, or issue trackers
- **ALWAYS** use different credentials for development, staging, and production
- **ROTATE** secrets periodically, especially after team member departures

## Docker Security

### Development

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your local development values
# Use strong passwords even in development

# Start services
docker compose up -d
```

### Production

For production deployments:

1. **Use Docker secrets or a secrets manager** (AWS Secrets Manager, HashiCorp Vault, etc.)
2. **Never expose database ports** to the public internet
3. **Use TLS/SSL** for all external communications
4. **Enable authentication** (`ENABLE_AUTH=true`)
5. **Use a strong, unique JWT_SECRET** (minimum 64 characters)

## Authentication

### Enabling Authentication

Set `ENABLE_AUTH=true` in your environment to require JWT authentication.

### JWT Best Practices

- Use a cryptographically strong random secret (64+ characters)
- Set appropriate token expiration times (`JWT_EXPIRES_IN`)
- Implement token refresh mechanisms for long sessions
- Store tokens securely on the client side (httpOnly cookies preferred)

### Test Users (Development Only)

After running `npm run seed-users`:
- admin / adminpassword
- johndoe / mypassword1

**WARNING:** Change these credentials immediately in any non-local environment.

## Database Security

### Connection Security

- Use SSL/TLS connections in production
- Restrict database access to application servers only
- Use least-privilege database users
- Enable connection pooling to prevent connection exhaustion

### Data Protection

- Passwords are hashed using bcrypt with appropriate cost factors
- Sensitive data should be encrypted at rest
- Regular backups should be encrypted

## API Security Checklist

- [ ] Enable authentication in production (`ENABLE_AUTH=true`)
- [ ] Use HTTPS for all API endpoints
- [ ] Implement rate limiting for public endpoints
- [ ] Validate and sanitize all user inputs
- [ ] Use parameterized queries (Prisma handles this)
- [ ] Log security-relevant events
- [ ] Regular dependency updates (`npm audit`)

## Secrets Rotation

### When to Rotate

- Immediately after a suspected breach
- When team members with access leave
- Periodically (recommended: every 90 days)

### How to Rotate

1. Generate new credentials
2. Update secrets manager / environment variables
3. Deploy updated configuration
4. Verify services are working
5. Revoke old credentials
6. Update any dependent services

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** create a public GitHub issue
2. Contact the security team directly
3. Provide detailed information about the vulnerability
4. Allow reasonable time for a fix before public disclosure

## Security Updates

Keep dependencies updated:

```bash
# Check for vulnerabilities
npm audit

# Fix automatically where possible
npm audit fix

# Check for outdated packages
npm outdated
```
