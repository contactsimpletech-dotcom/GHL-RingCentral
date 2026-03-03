require('dotenv').config();
const express = require('express');
const config = require('./config');
const webhookRouter = require('./routes/webhook');
const setupRouter = require('./routes/setup');
const { upsertWebhookSubscription } = require('./services/ringcentral');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);
app.use('/setup', setupRouter);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ghl-ringcentral' }));

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(config.port, async () => {
  console.log(`[server] Listening on port ${config.port}`);

  // Auto-register the RingCentral webhook subscription on startup
  if (config.serverUrl && config.ringcentral.jwt) {
    const webhookUrl = `${config.serverUrl}/webhook/ringcentral`;
    console.log(`[server] Auto-registering RingCentral webhook: ${webhookUrl}`);
    try {
      await upsertWebhookSubscription(webhookUrl);
    } catch (err) {
      // Non-fatal — subscription can be created manually via POST /setup/subscribe
      console.warn('[server] Could not auto-register webhook:', err.response?.data || err.message);
    }
  } else {
    console.warn('[server] SERVER_URL or RC_JWT not set — skipping auto-registration.');
    console.warn('[server] POST /setup/subscribe to register the webhook manually.');
  }
});
