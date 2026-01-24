# 🔐 Authentication System Documentation

## Overview

This document covers the complete authentication system implemented for the JustJeeps API application. The system features a **zero-downtime deployment** approach using feature flags, ensuring current users remain unaffected during implementation.

## 🏗️ Architecture

### Feature Flag Design
- **Safe Default**: Authentication is disabled by default (`ENABLE_AUTH=false`)
- **Gradual Rollout**: Can be enabled when ready without breaking existing functionality
- **Backward Compatible**: All endpoints work with or without authentication

### Technology Stack
- **Backend**: Node.js + Express.js + Prisma ORM
- **Frontend**: React 18.2.0 + Vite + Ant Design
- **Authentication**: JWT (JSON Web Tokens)
- **Password Security**: bcryptjs with salt rounds
- **Database**: PostgreSQL User table

## 📁 File Structure

```
JustJeepsAPI-back-end/
├── .env                           # Environment configuration
├── routes/
│   └── auth.js                    # Authentication API routes
├── middleware/
│   └── auth.js                    # JWT middleware with feature flag
├── prisma/
│   └── seeds/
│       ├── seed-individual/
│       │   └── seed-users.js      # User seeding script
│       └── hard-code_data/
│           └── users_data.js      # Test user data
└── server.js                     # Main server with auth integration

JustJeepsAPI-front-end/
├── src/
│   ├── context/
│   │   └── AuthContext.jsx        # React authentication state
│   ├── components/
│   │   └── auth/
│   │       ├── LoginForm.jsx      # Login form component
│   │       ├── LoginModal.jsx     # Modal wrapper
│   │       └── ProtectedRoute.jsx # Route protection
│   ├── pages/
│   │   └── LoginPage.jsx          # Dedicated login page
│   └── features/
│       └── navbar/
│           └── Navbar.jsx         # Updated with auth controls
```

## 🚀 Quick Start

### 1. Environment Setup

Create or update your `.env` file:

```bash
# Authentication Feature Flag (SAFE DEFAULT)
ENABLE_AUTH=false

# JWT Configuration (only used when auth is enabled)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=24h
```

### 2. Seed Users

Run the user seeding script to create test accounts:

```bash
npm run seed-users
```

### 3. Enable Authentication (When Ready)

```bash
# In .env file, change:
ENABLE_AUTH=true

# Then restart your backend server
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ENABLE_AUTH` | Feature flag to enable/disable auth | `false` | Yes |
| `JWT_SECRET` | Secret key for JWT token signing | - | When auth enabled |
| `JWT_EXPIRES_IN` | Token expiration time | `24h` | No |

### Database Schema

The authentication system uses a `User` table with the following structure:

```sql
model User {
  id        Int      @id @default(autoincrement())
  username  String   @unique
  email     String   @unique
  firstname String
  lastname  String
  password  String   // bcrypt hashed
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

## 🛡️ Security Features

### Password Security
- **bcryptjs hashing** with 10 salt rounds
- **No plaintext storage** - passwords are immediately hashed
- **Secure comparison** using bcrypt.compare()

### JWT Implementation
- **Secure token generation** with configurable expiration
- **Bearer token authentication** via Authorization header
- **Automatic token cleanup** on logout

### Feature Flag Protection
- **Safe middleware** that bypasses auth when disabled
- **Graceful degradation** - no breaking changes
- **Environment-controlled** activation

## 📡 API Endpoints

### Authentication Routes (`/api/auth`)

#### `POST /api/auth/login`
Login with username/email and password.

**Request:**
```json
{
  "username": "admin",
  "password": "adminpassword"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com",
    "firstname": "Admin",
    "lastname": "User"
  }
}
```

#### `POST /api/auth/register`
Create a new user account.

**Request:**
```json
{
  "username": "newuser",
  "email": "user@example.com",
  "firstname": "John",
  "lastname": "Doe",
  "password": "securepassword"
}
```

#### `GET /api/auth/status`
Check if authentication is enabled.

**Response:**
```json
{
  "authEnabled": true
}
```

#### `GET /api/auth/me`
Get current user information (requires authentication).

#### `POST /api/auth/logout`
Logout user (clears token).

## ⚛️ Frontend Integration

### AuthContext Provider

Wrap your app with the AuthProvider:

```jsx
import { AuthProvider } from './context/AuthContext';

function App() {
  return (
    <AuthProvider>
      {/* Your app components */}
    </AuthProvider>
  );
}
```

### Using Authentication Hook

```jsx
import { useAuth } from '../context/AuthContext';

function MyComponent() {
  const { 
    authEnabled, 
    isAuthenticated, 
    user, 
    login, 
    logout 
  } = useAuth();

  if (!authEnabled) {
    return <div>Authentication is disabled</div>;
  }

  if (!isAuthenticated) {
    return <LoginForm onLoginSuccess={(user) => console.log('Logged in:', user)} />;
  }

  return (
    <div>
      Welcome, {user.firstname}!
      <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

### Route Protection

Protect sensitive routes with ProtectedRoute:

```jsx
import ProtectedRoute from './components/auth/ProtectedRoute';

<Route path='/dashboard' element={
  <ProtectedRoute>
    <DashBoard />
  </ProtectedRoute>
} />
```

## 🧪 Testing

### Test User Accounts

After running `npm run seed-users`, test accounts are available. Check `prisma/seeds/hard-code_data/users_data.js` for credentials.

### Testing Routes

1. **Auth Test Page**: Visit `/auth-test` for comprehensive auth testing
2. **Login Page**: Visit `/login` for dedicated login interface
3. **Navbar Integration**: Sign in button appears when auth is enabled

### Manual Testing

```bash
# Check auth status
curl http://localhost:8080/api/auth/status

# Login test
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "adminpassword"}'

# Protected route test (with token)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:8080/api/auth/me
```

## 🔄 Deployment Guide

### Phase 1: Deploy with Auth Disabled (Safe)
1. Deploy the authentication system with `ENABLE_AUTH=false`
2. Verify all existing functionality works unchanged
3. Test auth endpoints return "disabled" status

### Phase 2: Enable Authentication
1. Change `ENABLE_AUTH=true` in environment
2. Restart the backend server
3. Frontend automatically detects auth is enabled
4. Login interface becomes available

### Phase 3: Route Protection (Optional)
1. Wrap sensitive routes with `<ProtectedRoute>`
2. Add authentication requirements as needed
3. Users will be prompted to login when accessing protected areas

## 🚨 Troubleshooting

### Common Issues

#### "Network Error" in Frontend
- **Cause**: Mixed content (HTTPS → HTTP requests)
- **Solution**: Ensure frontend uses proper API URL through Vite proxy

#### JWT Token Not Persisting
- **Cause**: LocalStorage not being set
- **Solution**: Check AuthContext token management

#### CORS Issues
- **Cause**: Frontend domain not allowed
- **Solution**: Update CORS origins in server.js

#### Auth Always Appears Disabled
- **Cause**: Environment variable not loaded
- **Solution**: Verify `.env` file and restart server

### Debug Commands

```bash
# Check environment loading
node -e "require('dotenv').config(); console.log(process.env.ENABLE_AUTH)"

# Test JWT secret
node -e "console.log(require('jsonwebtoken').sign({test: true}, 'your-secret'))"

# Database user check
npx prisma studio
```

## 📈 Future Enhancements

### Planned Features
- [ ] **Role-based permissions** (Admin, Manager, User)
- [ ] **Password reset functionality** via email
- [ ] **OAuth integration** (Google, GitHub)
- [ ] **Session management** with refresh tokens
- [ ] **Audit logging** for security events
- [ ] **Multi-factor authentication** (MFA)

### Performance Optimizations
- [ ] **Redis session store** for scalability
- [ ] **Token refresh middleware**
- [ ] **Rate limiting** on auth endpoints
- [ ] **Brute force protection**

## 🏷️ Version History

### v1.0.0 - Initial Implementation
- ✅ Feature flag authentication system
- ✅ JWT-based login/logout
- ✅ React context integration
- ✅ Route protection components
- ✅ User seeding system
- ✅ Comprehensive test suite

---

## 🆘 Support

For questions about the authentication system:
1. Check this documentation first
2. Review the test accounts and endpoints
3. Use the `/auth-test` page for debugging
4. Check server logs for detailed error messages

**Note**: This system is designed to be **production-ready** with security best practices and zero-downtime deployment capabilities.