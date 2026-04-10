const axios = require('axios');
const config = require('./config');
require('dotenv').config();

/**
 * Premier Performance Authentication Service
 * Handles API key authentication and Bearer token management
 */
class PremierAuth {
  constructor() {
    this.config = config.getConfig();
    this.baseURL = process.env.PREMIER_BASE_URL || this.config.baseURL;
    this.apiKey = this.config.credentials.apiKey;
  }

  static sessionToken = null;

  static tokenExpiry = null;

  /**
   * Get a valid access token (cached or fresh)
   * @returns {Promise<string>} Bearer token
   */
  async getAccessToken() {
    // Check if we have a valid cached token
    if (PremierAuth.sessionToken && PremierAuth.tokenExpiry && Date.now() < PremierAuth.tokenExpiry) {
      return PremierAuth.sessionToken;
    }

    // Get fresh token
    try {
      console.log('Premier: Requesting new session token...');
      
      const response = await axios.get(`${this.baseURL}/authenticate`, {
        params: {
          apiKey: this.apiKey
        },
        timeout: this.config.timeout.requestTimeout
      });

      if (response.data && response.data.sessionToken) {
        PremierAuth.sessionToken = response.data.sessionToken;
        // Premier tokens typically last 24 hours, set expiry for 23 hours to be safe
        PremierAuth.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
        
        console.log('Premier session token obtained successfully');
        return PremierAuth.sessionToken;
      } else {
        throw new Error('No session token in response');
      }
    } catch (error) {
      console.error('Premier authentication failed:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      throw new Error(`Premier authentication failed: ${error.message}`);
    }
  }

  /**
   * Get authenticated axios instance with Bearer token
   * @returns {Promise<object>} Configured axios instance
   */
  async getAuthenticatedClient() {
    const token = await this.getAccessToken();
    
    return axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: this.config.timeout.requestTimeout
    });
  }

  /**
   * Clear cached token (force re-authentication)
   */
  clearToken() {
    PremierAuth.sessionToken = null;
    PremierAuth.tokenExpiry = null;
    console.log('Premier session token cleared');
  }
}

module.exports = PremierAuth;