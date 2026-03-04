const express = require('express');
const axios = require('axios');
const { getToken } = require('../services/ringcentral');
const config = require('../config');

const router = express.Router();

/**
 * GET /audio/recording/:recordingId
 * Proxies a call recording so it can be played or downloaded in the browser.
 * ?download=1 forces a file download.
 */
router.get('/recording/:recordingId', async (req, res) => {
  const { recordingId } = req.params;
  const forceDownload = req.query.download === '1';
  try {
    const token = await getToken();
    const upstream = await axios.get(
      `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/recording/${recordingId}/content`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'stream' }
    );
    const contentType = upstream.headers['content-type'] || 'audio/mpeg';
    const ext = contentType.includes('wav') ? 'wav' : 'mp3';
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', forceDownload ? `attachment; filename="recording-${recordingId}.${ext}"` : `inline; filename="recording-${recordingId}.${ext}"`);
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    res.set('Accept-Ranges', 'bytes');
    upstream.data.pipe(res);
    upstream.data.on('error', (err) => { if (!res.headersSent) res.status(500).send('Stream error'); });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch recording', details: err.message });
  }
});

/**
 * GET /audio/voicemail/:extensionId/:messageId/:attachmentId
 * Proxies a voicemail attachment so it can be played or downloaded in the browser.
 */
router.get('/voicemail/:extensionId/:messageId/:attachmentId', async (req, res) => {
  const { extensionId, messageId, attachmentId } = req.params;
  const forceDownload = req.query.download === '1';
  try {
    const token = await getToken();
    const upstream = await axios.get(
      `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/${extensionId}/message-store/${messageId}/content/${attachmentId}`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'stream' }
    );
    const contentType = upstream.headers['content-type'] || 'audio/mpeg';
    const ext = contentType.includes('wav') ? 'wav' : 'mp3';
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', forceDownload ? `attachment; filename="voicemail-${messageId}.${ext}"` : `inline; filename="voicemail-${messageId}.${ext}"`);
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    res.set('Accept-Ranges', 'bytes');
    upstream.data.pipe(res);
    upstream.data.on('error', (err) => { if (!res.headersSent) res.status(500).send('Stream error'); });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch voicemail', details: err.message });
  }
});

/**
 * GET /audio/player/recording/:recordingId
 * GET /audio/player/voicemail/:extensionId/:messageId/:attachmentId
 * HTML audio player page — open in any browser tab to listen and download.
 */
router.get('/player/recording/:recordingId', (req, res) => {
  const { recordingId } = req.params;
  res.send(buildPlayerHtml(`Recording ${recordingId}`, `/audio/recording/${recordingId}`, `/audio/recording/${recordingId}?download=1`));
});

router.get('/player/voicemail/:extensionId/:messageId/:attachmentId', (req, res) => {
  const { extensionId, messageId, attachmentId } = req.params;
  res.send(buildPlayerHtml(`Voicemail ${messageId}`, `/audio/voicemail/${extensionId}/${messageId}/${attachmentId}`, `/audio/voicemail/${extensionId}/${messageId}/${attachmentId}?download=1`));
});

function buildPlayerHtml(title, streamUrl, downloadUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
    .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:2rem;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    h1{font-size:1rem;font-weight:600;color:#94a3b8;margin-bottom:1.25rem;letter-spacing:.03em;text-transform:uppercase}
    audio{width:100%;border-radius:8px;accent-color:#6366f1}
    .actions{margin-top:1.25rem;display:flex;gap:.75rem}
    a.btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.6rem 1rem;border-radius:8px;font-size:.875rem;font-weight:600;text-decoration:none;transition:opacity .15s}
    a.btn:hover{opacity:.85}
    .btn-primary{background:#6366f1;color:#fff}
    .btn-secondary{background:#334155;color:#cbd5e1}
  </style>
</head>
<body>
  <div class="card">
    <h1>🎙 ${title}</h1>
    <audio controls autoplay preload="metadata"><source src="${streamUrl}"/>Your browser does not support the audio element.</audio>
    <div class="actions">
      <a class="btn btn-primary" href="${downloadUrl}" download>⬇ Download</a>
      <a class="btn btn-secondary" href="${streamUrl}" target="_blank">🔗 Direct Link</a>
    </div>
  </div>
</body>
</html>`;
}

module.exports = router;