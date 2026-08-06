const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');
const { isTriageUser } = require('../config/triage');
require('dotenv').config();

const router = express.Router();
const prisma = require('../lib/prisma');

// Creating a user is an administrative operation: requires triage (env allowlist).
const requireTriage = (req, res, next) => {
  if (!req.user || !isTriageUser(req.user.username)) {
    return res.status(403).json({
      error: 'Not authorized',
      message: 'Only triage users can create accounts'
    });
  }
  next();
};

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign(
    { userId: userId },
    process.env.JWT_SECRET,
    // algorithm pinned: without it the token only relies on the library
    // rejecting "alg: none" by default, and a version bump could reopen
    // algorithm confusion.
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h', algorithm: 'HS256' }
  );
};

// Hash password
const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    // Check if authentication is enabled
    if (process.env.ENABLE_AUTH !== 'true') {
      return res.status(403).json({
        error: 'Authentication not enabled',
        message: 'Login functionality is currently disabled'
      });
    }

    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'Username and password are required'
      });
    }

    // Find user by username or email (case-insensitive: old accounts were
    // created with mixed capitalization and the triage allowlist compares in
    // lowercase, so the login has to resolve to the SAME account).
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: String(username).trim(), mode: 'insensitive' } },
          { email: { equals: String(username).trim(), mode: 'insensitive' } }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }

    // Generate token
    const token = generateToken(user.id);

    // Return success with token and user info
    res.json({
      success: true,
      message: 'Login successful',
      token: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstname: user.firstname,
        lastname: user.lastname
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Login failed',
      message: 'Internal server error during login'
    });
  }
});

// POST /api/auth/register: user creation.
//
// SECURITY: this route is mounted BEFORE the app.use('/api', authenticateToken)
// in server.js, so it has to require the token on its own. While it was public,
// anyone on the internet could create an account and get through every
// protected route, including picking a username that matched the triage
// allowlist (case-insensitive comparison), which granted feed uploads and
// script execution in production. Now it requires a logged in user AND triage.
router.post('/register', authenticateToken, requireTriage, async (req, res) => {
  try {
    // Check if authentication is enabled
    if (process.env.ENABLE_AUTH !== 'true') {
      return res.status(403).json({
        error: 'Authentication not enabled',
        message: 'Registration functionality is currently disabled'
      });
    }

    const { email, password, firstname, lastname } = req.body;
    // Username/email normalized: the triage allowlist compares in lowercase,
    // so storing "Ricardo" and "ricardo" as different accounts would be a bypass.
    const username = String(req.body.username || '').trim().toLowerCase();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    // Validate input
    if (!username || !normalizedEmail || !password || !firstname || !lastname) {
      return res.status(400).json({
        error: 'Missing information',
        message: 'All fields are required: username, email, password, firstname, lastname'
      });
    }

    // A case-insensitive collision is a collision too (the database still has
    // no unique index on username; see prisma/migrations/*_user_username_unique).
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: username, mode: 'insensitive' } },
          { email: { equals: normalizedEmail, mode: 'insensitive' } }
        ]
      }
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'User exists',
        message: 'Username or email already exists'
      });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user
    const newUser = await prisma.user.create({
      data: {
        username,
        email: normalizedEmail,
        password: hashedPassword,
        firstname,
        lastname
      },
      select: {
        id: true,
        username: true,
        email: true,
        firstname: true,
        lastname: true
      }
    });

    // Generate token
    const token = generateToken(newUser.id);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token: token,
      user: newUser
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Registration failed',
      message: 'Internal server error during registration'
    });
  }
});

// GET /api/auth/me - Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Failed to get user info',
      message: 'Internal server error'
    });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Since we're using JWT, logout is handled client-side by removing the token
  res.json({
    success: true,
    message: 'Logout successful'
  });
});

// GET /api/auth/status - Check if authentication is enabled
router.get('/status', (req, res) => {
  res.json({
    authEnabled: process.env.ENABLE_AUTH === 'true',
    message: process.env.ENABLE_AUTH === 'true' 
      ? 'Authentication is enabled' 
      : 'Authentication is disabled'
  });
});

module.exports = router;