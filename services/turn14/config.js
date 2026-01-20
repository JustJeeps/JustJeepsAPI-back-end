/**
 * Turn14 API Configuration
 * Manages environment variables and settings for Turn14 integration
 */

require('dotenv').config();

class Turn14Config {
  constructor() {
    this.validateConfig();
  }

  /**
   * Get Turn14 API credentials
   * @returns {object} API credentials
   */
  getCredentials() {
    return {
      clientId: process.env.TURN14_CLIENT_ID,
      clientSecret: process.env.TURN14_CLIENT_SECRET,
      environment: process.env.TURN14_ENVIRONMENT || 'testing'
    };
  }

  /**
   * Get API base URL based on environment
   * @returns {string} API base URL
   */
  getBaseURL() {
    const environment = process.env.TURN14_ENVIRONMENT || 'testing';
    return environment === 'production' 
      ? 'https://api.turn14.com'
      : 'https://apitest.turn14.com';
  }

  /**
   * Get API timeout settings
   * @returns {object} Timeout configurations
   */
  getTimeoutSettings() {
    return {
      requestTimeout: parseInt(process.env.TURN14_REQUEST_TIMEOUT) || 30000, // 30 seconds
      retryDelay: parseInt(process.env.TURN14_RETRY_DELAY) || 1000, // 1 second
      maxRetries: parseInt(process.env.TURN14_MAX_RETRIES) || 3
    };
  }

  /**
   * Get rate limiting settings
   * @returns {object} Rate limiting configurations
   */
  getRateLimitSettings() {
    return {
      requestsPerSecond: parseInt(process.env.TURN14_RATE_LIMIT) || 10,
      batchSize: parseInt(process.env.TURN14_BATCH_SIZE) || 5,
      batchDelay: parseInt(process.env.TURN14_BATCH_DELAY) || 1000
    };
  }

  /**
   * Get logging settings
   * @returns {object} Logging configurations
   */
  getLoggingSettings() {
    return {
      logLevel: process.env.TURN14_LOG_LEVEL || 'info',
      logRequests: process.env.TURN14_LOG_REQUESTS === 'true',
      logResponses: process.env.TURN14_LOG_RESPONSES === 'true'
    };
  }

  /**
   * Validate required environment variables
   * @throws {Error} If required variables are missing
   */
  validateConfig() {
    const required = ['TURN14_CLIENT_ID', 'TURN14_CLIENT_SECRET'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required Turn14 environment variables: ${missing.join(', ')}\n` +
        'Please add them to your .env file:\n' +
        'TURN14_CLIENT_ID="your_client_id_here"\n' +
        'TURN14_CLIENT_SECRET="your_client_secret_here"\n' +
        'TURN14_ENVIRONMENT="testing"  # or "production"');
    }

    // Validate environment value
    const environment = process.env.TURN14_ENVIRONMENT;
    if (environment && !['testing', 'production'].includes(environment)) {
      throw new Error('TURN14_ENVIRONMENT must be either "testing" or "production"');
    }
  }

  /**
   * Check if running in production environment
   * @returns {boolean} True if production environment
   */
  isProduction() {
    return process.env.TURN14_ENVIRONMENT === 'production';
  }

  /**
   * Get all configuration as object
   * @returns {object} Complete configuration
   */
  getConfig() {
    return {
      credentials: this.getCredentials(),
      baseURL: this.getBaseURL(),
      timeout: this.getTimeoutSettings(),
      rateLimit: this.getRateLimitSettings(),
      logging: this.getLoggingSettings(),
      isProduction: this.isProduction()
    };
  }

  /**
   * Print configuration summary (without sensitive data)
   */
  printConfigSummary() {
    const config = this.getConfig();
    console.log('Turn14 API Configuration:');
    console.log(`  Environment: ${config.credentials.environment}`);
    console.log(`  Base URL: ${config.baseURL}`);
    console.log(`  Client ID: ${config.credentials.clientId ? config.credentials.clientId.substring(0, 8) + '...' : 'NOT SET'}`);
    console.log(`  Client Secret: ${config.credentials.clientSecret ? '[SET]' : '[NOT SET]'}`);
    console.log(`  Request Timeout: ${config.timeout.requestTimeout}ms`);
    console.log(`  Rate Limit: ${config.rateLimit.requestsPerSecond} requests/second`);
    console.log(`  Batch Size: ${config.rateLimit.batchSize}`);
  }
}

// Export singleton instance
module.exports = new Turn14Config();