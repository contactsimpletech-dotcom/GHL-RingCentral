require('dotenv').config();

const config = {
  port: process.env.PORT || 3000,
  serverUrl: process.env.SERVER_URL || '',

  ringcentral: {
    clientId: process.env.RC_CLIENT_ID,
    clientSecret: process.env.RC_CLIENT_SECRET,
    jwt: process.env.RC_JWT,
    serverUrl: process.env.RC_SERVER_URL || 'https://platform.ringcentral.com',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  ghl: {
    apiKey: process.env.GHL_API_KEY,
    locationId: process.env.GHL_LOCATION_ID,
    baseUrl: 'https://services.leadconnectorhq.com',
  },
};

function validate() {
  const required = [
    ['RC_CLIENT_ID', config.ringcentral.clientId],
    ['RC_CLIENT_SECRET', config.ringcentral.clientSecret],
    ['RC_JWT', config.ringcentral.jwt],
    ['OPENAI_API_KEY', config.openai.apiKey],
    ['GHL_API_KEY', config.ghl.apiKey],
    ['GHL_LOCATION_ID', config.ghl.locationId],
  ];

  const missing = required.filter(([, val]) => !val).map(([key]) => key);
  if (missing.length > 0) {
    console.warn(`[config] Missing environment variables: ${missing.join(', ')}`);
  }
}

validate();

module.exports = config;
