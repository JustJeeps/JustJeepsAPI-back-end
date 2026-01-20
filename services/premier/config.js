/**
 * Premier Performance API Configuration
 * Manages environment variables and settings for Premier Performance integration
 */

require('dotenv').config();

class PremierConfig {
  constructor() {
    this.validateConfig();
  }

  /**
   * Get Premier API credentials
   * @returns {object} API credentials
   */
  getCredentials() {
    return {
      apiKey: process.env.PREMIER_API_KEY || '336d0295-2c2f-451a-b5a5-0cfa55f41b16',
      environment: process.env.PREMIER_ENVIRONMENT || 'production'
    };
  }

  /**
   * Get API base URL based on environment
   * @returns {string} API base URL
   */
  getBaseURL() {
    const environment = process.env.PREMIER_ENVIRONMENT || 'production';
    return environment === 'production' 
      ? 'https://api.premierwd.com/api/v5'
      : 'http://api-test.premierwd.com/api/v5';
  }

  /**
   * Get API timeout settings
   * @returns {object} Timeout configurations
   */
  getTimeoutSettings() {
    return {
      requestTimeout: parseInt(process.env.PREMIER_REQUEST_TIMEOUT) || 30000, // 30 seconds
      retryDelay: parseInt(process.env.PREMIER_RETRY_DELAY) || 1000, // 1 second
      maxRetries: parseInt(process.env.PREMIER_MAX_RETRIES) || 3
    };
  }

  /**
   * Get rate limiting settings
   * @returns {object} Rate limiting configurations
   */
  getRateLimitSettings() {
    return {
      requestsPerSecond: parseInt(process.env.PREMIER_RATE_LIMIT) || 10,
      batchSize: parseInt(process.env.PREMIER_BATCH_SIZE) || 50, // Premier allows up to 50 items per request
      batchDelay: parseInt(process.env.PREMIER_BATCH_DELAY) || 1000
    };
  }

  /**
   * Get logging settings
   * @returns {object} Logging configurations
   */
  getLoggingSettings() {
    return {
      logLevel: process.env.PREMIER_LOG_LEVEL || 'info',
      logRequests: process.env.PREMIER_LOG_REQUESTS === 'true',
      logResponses: process.env.PREMIER_LOG_RESPONSES === 'true'
    };
  }

  /**
   * Validate required environment variables
   * @throws {Error} If required variables are missing
   */
  validateConfig() {
    const required = ['PREMIER_API_KEY'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.warn(`Missing Premier environment variables: ${missing.join(', ')}\n` +
        'Using default API key. For production, please add to your .env file:\n' +
        'PREMIER_API_KEY="your_api_key_here"\n' +
        'PREMIER_ENVIRONMENT="production"  # or "test"');
    }

    // Validate environment value
    const environment = process.env.PREMIER_ENVIRONMENT;
    if (environment && !['test', 'production'].includes(environment)) {
      throw new Error('PREMIER_ENVIRONMENT must be either "test" or "production"');
    }
  }

  /**
   * Check if running in production environment
   * @returns {boolean} True if production environment
   */
  isProduction() {
    return process.env.PREMIER_ENVIRONMENT === 'production';
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
    console.log('Premier Performance API Configuration:');
    console.log(`  Environment: ${config.credentials.environment}`);
    console.log(`  Base URL: ${config.baseURL}`);
    console.log(`  API Key: ${config.credentials.apiKey ? config.credentials.apiKey.substring(0, 8) + '...' : 'NOT SET'}`);
    console.log(`  Request Timeout: ${config.timeout.requestTimeout}ms`);
    console.log(`  Rate Limit: ${config.rateLimit.requestsPerSecond} requests/second`);
    console.log(`  Batch Size: ${config.rateLimit.batchSize} items per request`);
  }
}

// Export singleton instance
module.exports = new PremierConfig();