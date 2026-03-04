const express = require('express');
const { downloadRecording, downloadVoicemail, getRecentVoicemails } = require('../services/ringcentral');
const { transcribe, extractCallerInfo } = require('../services/transcription');
const { findContactByPhone, createContact, updateContact, addNote } = require('../services/ghl');
const config = require('../config');

const router = express.Router();
const _processedVoicemails = new Set();

function audioBaseUrl() {
  return (config.serverUrl || '').replace(/\/$/, '');
}

router.post('/ringcentral', async (req, res) => {
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    console.log('[webhook] RingCentral validation handshake received');
    return res.status(200).set('Validation-Token', validationToken).send();
  }

  res.status(200).json({ received: true });

  const body = req.body;
  const event = body?.body ?? body;
  if (!event) return;

  const isVoicemailEvent =
    (body?.event || '').includes('message-store') ||
    (event.changes || []).some((c) => c.type === 'VoiceMail');

  if (isVoicemailEvent) {
    const extensionId = event.extensionId || body?.ownerId || '~';
    console.log(`[webhook] Voicemail event for extension ${extensionId}`);
    getRecentVoicemails(extensionId)
      .then((messages) => {
        for (const msg of messages) {
          if (_processedVoicemails.has(msg.id)) continue;
          _processedVoicemails.add(msg.id);
          const attachment = (msg.attachments || []).find(
            (a) => a.type === 'AudioRecording' || a.contentType?.startsWith('audio/')
          );
          if (!attachment) continue;
          const callerPhone = msg.from?.phoneNumber || msg.from?.extensionNumber || null;
          const calledPhone = msg.to?.[0]?.phoneNumber || msg.to?.[0]?.extensionNumber || null;
          processVoicemail({
            extensionId, messageId: msg.id, attachmentId: attachment.id,
            callerPhone, calledPhone, creationTime: msg.creationTime,
          }).catch((err) => console.error(`[webhook] Voicemail pipeline failed for ${msg.id}:`, err.message));
        }
      })
      .catch((err) => console.error('[webhook] Failed to fetch voicemails:', err.message));
    return;
  }

  const parties = event.parties || [];
  const sessionId = event.telephonySessionId || event.sessionId || 'unknown';
  console.log(`[webhook] Telephony session ${sessionId} — ${parties.length} parties`);

  for (const party of parties) {
    const status = party.status?.code;
    const recordings = party.recordings || [];
    if (status !== 'Disconnected' || recordings.length === 0) continue;
    const callerPhone = party.from?.phoneNumber || party.from?.extensionNumber || null;
    const calledPhone = party.to?.phoneNumber || party.to?.extensionNumber || null;
    const direction = party.direction || 'Unknown';
    const durationSeconds = party.endTime && party.startTime
      ? Math.round((new Date(party.endTime) - new Date(party.startTime)) / 1000) : null;
    for (const rec of recordings) {
      if (!rec.id) continue;
      processRecording({ recordingId: rec.id, callerPhone, calledPhone, direction, durationSeconds, sessionId })
        .catch((err) => console.error(`[webhook] Pipeline failed for recording ${rec.id}:`, err.message));
    }
  }
});

async function processRecording({ recordingId, callerPhone, calledPhone, direction, durationSeconds, sessionId }) {
  console.log(`[pipeline] Starting for recording ${recordingId}`);
  const { buffer, contentType } = await downloadRecording(recordingId);
  const transcript = await transcribe(buffer, contentType);

  const callerPhone_ = direction === 'Inbound' ? callerPhone : calledPhone;
  if (!callerPhone_) { console.warn('[pipeline] No caller phone — skipping GHL update'); return; }

  const info = await extractCallerInfo(transcript);

  const existingContact = await findContactByPhone(callerPhone_);
  let contact;
  if (existingContact) {
    contact = existingContact;
    await updateContact(contact.id, info);
  } else {
    contact = await createContact(callerPhone_, info);
  }

  const base = audioBaseUrl();
  const playerUrl   = base ? `${base}/audio/player/recording/${recordingId}` : null;
  const streamUrl   = base ? `${base}/audio/recording/${recordingId}` : null;
  const downloadUrl = base ? `${base}/audio/recording/${recordingId}?download=1` : null;

  const callDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const durationStr = durationSeconds != null
    ? `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s` : 'unknown';

  const noteBody = [
    `Call Transcript — ${direction} Call`,
    `Date: ${callDate}`,
    `From: ${callerPhone || 'unknown'}`,
    `To:   ${calledPhone || 'unknown'}`,
    `Duration: ${durationStr}`,
    `Session ID: ${sessionId}`,
    `Recording ID: ${recordingId}`,
    '',
    '─── Audio ───',
    playerUrl   ? `▶ Listen in browser : ${playerUrl}`   : '(Set SERVER_URL for audio links)',
    downloadUrl ? `⬇ Download audio    : ${downloadUrl}` : '',
    streamUrl   ? `🔗 Direct stream     : ${streamUrl}`   : '',
    '',
    '─── Transcript ───',
    transcript || '(no speech detected)',
  ].join('\n');

  await addNote(contact.id, noteBody);
  console.log(`[pipeline] Done — note added to GHL contact ${contact.id}`);
}

async function processVoicemail({ extensionId, messageId, attachmentId, callerPhone, calledPhone, creationTime }) {
  console.log(`[voicemail] Starting for message ${messageId}`);
  const { buffer, contentType } = await downloadVoicemail(extensionId, messageId, attachmentId);
  const transcript = await transcribe(buffer, contentType);

  if (!callerPhone) { console.warn('[voicemail] No caller phone — skipping GHL update'); return; }

  const info = await extractCallerInfo(transcript);

  const existingContact = await findContactByPhone(callerPhone);
  let contact;
  if (existingContact) {
    contact = existingContact;
    await updateContact(contact.id, info);
  } else {
    contact = await createContact(callerPhone, info);
  }

  const base = audioBaseUrl();
  const playerUrl   = base ? `${base}/audio/player/voicemail/${extensionId}/${messageId}/${attachmentId}` : null;
  const streamUrl   = base ? `${base}/audio/voicemail/${extensionId}/${messageId}/${attachmentId}` : null;
  const downloadUrl = base ? `${base}/audio/voicemail/${extensionId}/${messageId}/${attachmentId}?download=1` : null;

  const vmDate = creationTime
    ? new Date(creationTime).toLocaleString('en-US', { timeZone: 'America/New_York' })
    : new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const noteBody = [
    'Voicemail Transcript',
    `Date: ${vmDate}`,
    `From: ${callerPhone || 'unknown'}`,
    `To:   ${calledPhone || 'unknown'}`,
    `Message ID: ${messageId}`,
    '',
    '─── Audio ───',
    playerUrl   ? `▶ Listen in browser : ${playerUrl}`   : '(Set SERVER_URL for audio links)',
    downloadUrl ? `⬇ Download audio    : ${downloadUrl}` : '',
    streamUrl   ? `🔗 Direct stream     : ${streamUrl}`   : '',
    '',
    '─── Transcript ───',
    transcript || '(no speech detected)',
  ].join('\n');

  await addNote(contact.id, noteBody);
  console.log(`[voicemail] Done — note added to GHL contact ${contact.id}`);
}

module.exports = router;