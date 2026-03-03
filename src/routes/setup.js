const express = require('express');
const { upsertWebhookSubscription } = require('../services/ringcentral');
const config = require('../config');

const router = express.Router();

/**
 * POST /setup/subscribe
 *
 * Creates (or renews) the RingCentral webhook subscription that points at
 * this server's /webhook/ringcentral endpoint.
 *
 * Call this once after deployment. The subscription lasts 7 days — this
 * server also calls it automatically on startup so it stays fresh across
 * Render restarts.
 *
 * Optional body: { "webhookUrl": "https://custom-url/webhook/ringcentral" }
 */
router.post('/subscribe', async (req, res) => {
  try {
    const webhookUrl =
      req.body?.webhookUrl ||
      `${config.serverUrl}/webhook/ringcentral`;

    if (!webhookUrl.startsWith('http')) {
      return res.status(400).json({
        error: 'Cannot determine webhook URL. Set SERVER_URL in your environment or pass webhookUrl in the request body.',
      });
    }

    console.log(`[setup] Registering RingCentral webhook: ${webhookUrl}`);
    const subscription = await upsertWebhookSubscription(webhookUrl);

    res.json({
      ok: true,
      message: 'RingCentral webhook subscription is active',
      subscriptionId: subscription.id,
      expiresAt: subscription.expirationTime,
      webhookUrl,
    });
  } catch (err) {
    console.error('[setup] Subscription failed:', err.response?.data || err.message);
    res.status(502).json({
      error: 'Failed to create RingCentral webhook subscription',
      details: err.response?.data || err.message,
    });
  }
});

/**
 * GET /setup/status
 * Returns a summary of current configuration (no secrets shown in full).
 */
router.get('/status', (req, res) => {
  const mask = (val) => (val ? `${val.slice(0, 4)}...${val.slice(-4)}` : 'NOT SET');

  res.json({
    ringcentral: {
      clientId: mask(config.ringcentral.clientId),
      clientSecret: mask(config.ringcentral.clientSecret),
      jwt: mask(config.ringcentral.jwt),
      serverUrl: config.ringcentral.serverUrl,
    },
    openai: {
      apiKey: mask(config.openai.apiKey),
    },
    ghl: {
      apiKey: mask(config.ghl.apiKey),
      locationId: config.ghl.locationId || 'NOT SET',
    },
    server: {
      serverUrl: config.serverUrl || 'NOT SET — set SERVER_URL env var',
      webhookEndpoint: config.serverUrl
        ? `${config.serverUrl}/webhook/ringcentral`
        : 'unknown',
    },
  });
});

module.exports = router;
