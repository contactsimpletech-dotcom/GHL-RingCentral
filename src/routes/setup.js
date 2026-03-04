const express = require('express');
const { upsertWebhookSubscription, getToken, downloadVoicemail } = require('../services/ringcentral');
const { transcribe, extractCallerName } = require('../services/transcription');
const { findContactByPhone, createContact, addNote } = require('../services/ghl');
const config = require('../config');
const axios = require('axios');

const router = express.Router();

/**
 * POST /setup/subscribe
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
    openai: { apiKey: mask(config.openai.apiKey) },
    ghl: {
      apiKey: mask(config.ghl.apiKey),
      locationId: config.ghl.locationId || 'NOT SET',
    },
    server: {
      serverUrl: config.serverUrl || 'NOT SET — set SERVER_URL env var',
      webhookEndpoint: config.serverUrl ? `${config.serverUrl}/webhook/ringcentral` : 'unknown',
    },
  });
});

/**
 * GET /setup/reprocess/:messageId
 * Reprocesses an existing voicemail — downloads audio, transcribes,
 * adds a new GHL note with listen + download links, and shows a player page.
 *
 * Example: https://ghl-ringcentral.onrender.com/setup/reprocess/3470704185053
 */
router.get('/reprocess/:messageId', async (req, res) => {
  const { messageId } = req.params;
  const extensionId = req.query.extensionId || '~';
  console.log(`[reprocess] Looking up message ${messageId}`);

  try {
    const token = await getToken();
    const { serverUrl } = config.ringcentral;

    const msgRes = await axios.get(
      `${serverUrl}/restapi/v1.0/account/~/extension/${extensionId}/message-store/${messageId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const msg = msgRes.data;
    const attachment = (msg.attachments || []).find(
      (a) => a.type === 'AudioRecording' || a.contentType?.startsWith('audio/')
    );

    if (!attachment) {
      return res.status(404).json({ error: 'No audio attachment found for this message.' });
    }

    const callerPhone = msg.from?.phoneNumber || msg.from?.extensionNumber || null;
    const calledPhone = msg.to?.[0]?.phoneNumber || msg.to?.[0]?.extensionNumber || null;
    const attachmentId = attachment.id;

    const { buffer, contentType } = await downloadVoicemail(extensionId, messageId, attachmentId);
    const transcript = await transcribe(buffer, contentType);

    let contact;
    if (callerPhone) {
      const existing = await findContactByPhone(callerPhone);
      contact = existing || await createContact(callerPhone, ...(Object.values(await extractCallerName(transcript))));
    }

    const base = (config.serverUrl || '').replace(/\/$/, '');
    const playerUrl   = `${base}/audio/player/voicemail/${extensionId}/${messageId}/${attachmentId}`;
    const streamUrl   = `${base}/audio/voicemail/${extensionId}/${messageId}/${attachmentId}`;
    const downloadUrl = `${base}/audio/voicemail/${extensionId}/${messageId}/${attachmentId}?download=1`;

    const vmDate = msg.creationTime
      ? new Date(msg.creationTime).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    const noteBody = [
      'Voicemail Transcript (Reprocessed)',
      `Date: ${vmDate}`,
      `From: ${callerPhone || 'unknown'}`,
      `To:   ${calledPhone || 'unknown'}`,
      `Message ID: ${messageId}`,
      '',
      '─── Audio ───',
      `▶ Listen in browser : ${playerUrl}`,
      `⬇ Download audio    : ${downloadUrl}`,
      `🔗 Direct stream     : ${streamUrl}`,
      '',
      '─── Transcript ───',
      transcript || '(no speech detected)',
    ].join('\n');

    if (contact) await addNote(contact.id, noteBody);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Voicemail ${messageId}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
    .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:2rem;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    h1{font-size:1rem;font-weight:600;color:#94a3b8;margin-bottom:1.25rem;text-transform:uppercase;letter-spacing:.03em}
    audio{width:100%;border-radius:8px;accent-color:#6366f1;margin-bottom:1.25rem}
    .actions{display:flex;gap:.75rem;margin-bottom:1.5rem}
    a.btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.6rem 1rem;border-radius:8px;font-size:.875rem;font-weight:600;text-decoration:none;transition:opacity .15s}
    a.btn:hover{opacity:.85}
    .btn-primary{background:#6366f1;color:#fff}
    .btn-secondary{background:#334155;color:#cbd5e1}
    .meta{font-size:.8rem;color:#64748b;margin-bottom:1rem;line-height:1.8}
    .success{color:#34d399;font-size:.8rem;margin-bottom:1rem}
    .transcript{background:#0f172a;border-radius:8px;padding:1rem;font-size:.875rem;line-height:1.6;color:#cbd5e1;white-space:pre-wrap}
  </style>
</head>
<body>
  <div class="card">
    <h1>🎙 Voicemail ${messageId}</h1>
    <div class="meta">From: ${callerPhone || 'unknown'}<br/>To: ${calledPhone || 'unknown'}<br/>Date: ${vmDate}</div>
    <audio controls autoplay preload="metadata"><source src="${streamUrl}"/></audio>
    <div class="actions">
      <a class="btn btn-primary" href="${downloadUrl}" download>⬇ Download</a>
      <a class="btn btn-secondary" href="${streamUrl}" target="_blank">🔗 Direct Link</a>
    </div>
    ${contact ? `<div class="success">✅ Note added to GHL contact ${contact.id}</div>` : ''}
    <div class="transcript">${transcript || '(no speech detected)'}</div>
  </div>
</body>
</html>`);

  } catch (err) {
    console.error('[reprocess] Failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'Reprocess failed', details: err.response?.data || err.message });
  }
});

module.exports = router;