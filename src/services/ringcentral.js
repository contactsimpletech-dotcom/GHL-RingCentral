const axios = require('axios');
const config = require('../config');

// In-memory token cache
let _token = null;
let _tokenExpiresAt = 0;

/**
 * Get a valid RingCentral OAuth access token using JWT grant.
 * Caches the token until 60 seconds before expiry.
 */
async function getToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) {
    return _token;
  }

  const { clientId, clientSecret, jwt, serverUrl } = config.ringcentral;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    `${serverUrl}/restapi/oauth/token`,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  _token = res.data.access_token;
  _tokenExpiresAt = Date.now() + res.data.expires_in * 1000;

  console.log('[ringcentral] Access token obtained, expires in', res.data.expires_in, 's');
  return _token;
}

/**
 * Download a call recording by its RC recording ID.
 * Returns a Buffer of the audio content and the content-type header.
 */
async function downloadRecording(recordingId) {
  const token = await getToken();
  const { serverUrl } = config.ringcentral;

  const res = await axios.get(
    `${serverUrl}/restapi/v1.0/account/~/recording/${recordingId}/content`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    }
  );

  return {
    buffer: Buffer.from(res.data),
    contentType: res.headers['content-type'] || 'audio/mpeg',
  };
}

/**
 * Download a voicemail attachment from the RingCentral message store.
 * Returns a Buffer of the audio content and the content-type header.
 */
async function downloadVoicemail(extensionId, messageId, attachmentId) {
  const token = await getToken();
  const { serverUrl } = config.ringcentral;

  const res = await axios.get(
    `${serverUrl}/restapi/v1.0/account/~/extension/${extensionId}/message-store/${messageId}/content/${attachmentId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    }
  );

  return {
    buffer: Buffer.from(res.data),
    contentType: res.headers['content-type'] || 'audio/mpeg',
  };
}

/**
 * Fetch recent voicemail messages for an extension from the message store.
 */
async function getRecentVoicemails(extensionId) {
  const token = await getToken();
  const { serverUrl } = config.ringcentral;

  const res = await axios.get(
    `${serverUrl}/restapi/v1.0/account/~/extension/${extensionId}/message-store`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { messageType: 'VoiceMail', readStatus: 'Unread', perPage: 10 },
    }
  );

  return res.data.records || [];
}

/**
 * Create (or renew) a RingCentral webhook subscription for telephony session events
 * and voicemail message-store events.
 * The subscription expires in 7 days; call this on server startup to keep it fresh.
 */
async function upsertWebhookSubscription(webhookUrl) {
  const token = await getToken();
  const { serverUrl } = config.ringcentral;

  const eventFilters = [
    '/restapi/v1.0/account/~/telephony/sessions',
    '/restapi/v1.0/account/~/extension/~/message-store',
  ];

  // List existing subscriptions to avoid duplicates
  const listRes = await axios.get(`${serverUrl}/restapi/v1.0/subscription`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const subscriptions = listRes.data.records || [];
  const existing = subscriptions.find(
    (s) =>
      s.deliveryMode?.address === webhookUrl &&
      s.status === 'Active'
  );

  if (existing) {
    // Renew and ensure both event filters are present
    const renewRes = await axios.put(
      `${serverUrl}/restapi/v1.0/subscription/${existing.id}`,
      { eventFilters, expiresIn: 604800 },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('[ringcentral] Webhook subscription renewed:', renewRes.data.id);
    return renewRes.data;
  }

  // Create a new subscription
  const createRes = await axios.post(
    `${serverUrl}/restapi/v1.0/subscription`,
    {
      eventFilters,
      deliveryMode: {
        transportType: 'WebHook',
        address: webhookUrl,
      },
      expiresIn: 604800, // 7 days
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }
  );

  console.log('[ringcentral] Webhook subscription created:', createRes.data.id);
  return createRes.data;
}

module.exports = { getToken, downloadRecording, downloadVoicemail, getRecentVoicemails, upsertWebhookSubscription };
