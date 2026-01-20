const axios = require('axios');
require('dotenv').config();

/**
 * Premier Performance Authentication Service
 * Handles API key authentication and Bearer token management
 */
class PremierAuth {
  constructor() {
    this.baseURL = process.env.PREMIER_BASE_URL || 'https://api.premierwd.com/api/v5';
    this.apiKey = process.env.PREMIER_API_KEY;
    this.sessionToken = null;
    this.tokenExpiry = null;
    
    if (!this.apiKey) {
      throw new Error('PREMIER_API_KEY environment variable is required');
    }
  }

  /**
   * Get a valid access token (cached or fresh)
   * @returns {Promise<string>} Bearer token
   */
  async getAccessToken() {
    // Check if we have a valid cached token
    if (this.sessionToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.sessionToken;
    }

    // Get fresh token
    try {
      console.log('Premier: Requesting new session token...');
      
      const response = await axios.get(`${this.baseURL}/authenticate`, {
        params: {
          apiKey: this.apiKey
        },
        timeout: 10000
      });

      if (response.data && response.data.sessionToken) {
        this.sessionToken = response.data.sessionToken;
        // Premier tokens typically last 24 hours, set expiry for 23 hours to be safe
        this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
        
        console.log('Premier session token obtained successfully');
        return this.sessionToken;
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
      timeout: 30000
    });
  }

  /**
   * Clear cached token (force re-authentication)
   */
  clearToken() {
    this.sessionToken = null;
    this.tokenExpiry = null;
    console.log('Premier session token cleared');
  }
}

module.exports = PremierAuth;