const jwt = require('jsonwebtoken');
require('dotenv').config();

const prisma = require('../lib/prisma');

// Safe authentication middleware with feature flag
const authenticateToken = (req, res, next) => {
  // Allow CORS preflight requests (OPTIONS) to pass through
  if (req.method === 'OPTIONS') {
    return next();
  }

  // 🛡️ SAFETY FIRST: Check if authentication is enabled
  if (process.env.ENABLE_AUTH !== 'true') {
    console.log('🔓 Authentication disabled - allowing request');
    return next(); // Skip authentication entirely
  }

  // Authentication is enabled - proceed with JWT verification
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      error: 'Access token required',
      message: 'Authentication is required to access this endpoint'
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        error: 'Invalid or expired token',
        message: 'Please login again'
      });
    }

    try {
      // Get user info from database
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, email: true, firstname: true, lastname: true }
      });

      if (!user) {
        return res.status(403).json({ 
          error: 'User not found',
          message: 'Invalid user credentials'
        });
      }

      req.user = user; // Attach user info to request
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      return res.status(500).json({ 
        error: 'Authentication error',
        message: 'Internal server error during authentication'
      });
    }
  });
};

// Optional authentication - for routes that work with or without auth
const optionalAuth = (req, res, next) => {
  if (process.env.ENABLE_AUTH !== 'true') {
    return next(); // Skip authentication entirely
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(); // No token provided, continue without user
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (!err && decoded) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { id: true, username: true, email: true, firstname: true, lastname: true }
        });
        req.user = user;
      } catch (error) {
        console.error('Optional auth error:', error);
      }
    }
    next();
  });
};

module.exports = {
  authenticateToken,
  optionalAuth
};