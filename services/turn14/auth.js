const axios = require('axios');
const config = require('./config');

class Turn14Auth {
  constructor() {
    this.config = config.getConfig();
    this.baseURL = this.config.baseURL;
    this.tokenData = null;
    this.tokenExpiry = null;
  }

  /**
   * Get OAuth 2 access token using client credentials flow
   * @returns {Promise<string>} Access token
   */
  async getAccessToken() {
    try {
      // Check if we have a valid token
      if (this.isTokenValid()) {
        return this.tokenData.access_token;
      }

      // Get new token
      await this.refreshToken();
      return this.tokenData.access_token;
    } catch (error) {
      console.error('Error getting Turn14 access token:', error.message);
      throw error;
    }
  }

  /**
   * Check if current token is valid and not expired
   * @returns {boolean}
   */
  isTokenValid() {
    if (!this.tokenData || !this.tokenExpiry) {
      return false;
    }

    // Add 60 second buffer before expiry
    const bufferTime = 60 * 1000;
    return Date.now() < (this.tokenExpiry - bufferTime);
  }

  /**
   * Request new access token from Turn14 API
   */
  async refreshToken() {
    try {
      const response = await axios.post(`${this.baseURL}/v1/token`, {
        grant_type: 'client_credentials',
        client_id: this.config.credentials.clientId,
        client_secret: this.config.credentials.clientSecret
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: this.config.timeout.requestTimeout
      });

      this.tokenData = response.data;
      // expires_in is in seconds, convert to milliseconds and add to current time
      this.tokenExpiry = Date.now() + (this.tokenData.expires_in * 1000);

      console.log('Turn14 access token refreshed successfully');
    } catch (error) {
      console.error('Error refreshing Turn14 token:', error.response?.data || error.message);
      throw new Error(`Turn14 authentication failed: ${error.response?.data?.error || error.message}`);
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
        'Content-Type': 'application/json'
      },
      timeout: this.config.timeout.requestTimeout // Use configured timeout
    });
  }

  /**
   * Validate environment variables are set
   */
  validateConfig() {
    config.validateConfig(); // Use the config module's validation
  }
}

module.exports = Turn14Auth;