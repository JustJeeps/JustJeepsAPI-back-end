const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();
const prisma = require('../lib/prisma');

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign(
    { userId: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
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

    // Find user by username or email
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username },
          { email: username }
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

// POST /api/auth/register (optional - for creating new users)
router.post('/register', async (req, res) => {
  try {
    // Check if authentication is enabled
    if (process.env.ENABLE_AUTH !== 'true') {
      return res.status(403).json({
        error: 'Authentication not enabled',
        message: 'Registration functionality is currently disabled'
      });
    }

    const { username, email, password, firstname, lastname } = req.body;

    // Validate input
    if (!username || !email || !password || !firstname || !lastname) {
      return res.status(400).json({
        error: 'Missing information',
        message: 'All fields are required: username, email, password, firstname, lastname'
      });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username },
          { email: email }
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
        email,
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