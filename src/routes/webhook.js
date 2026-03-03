const express = require('express');
const { downloadRecording, downloadVoicemail, getRecentVoicemails } = require('../services/ringcentral');
const { transcribe, extractCallerName } = require('../services/transcription');
const { findContactByPhone, createContact, addNote } = require('../services/ghl');

const router = express.Router();

// Track processed voicemail IDs to avoid double-processing
const _processedVoicemails = new Set();

/**
 * POST /webhook/ringcentral
 *
 * Handles two event types from RingCentral:
 *
 * 1. Telephony session events — call recordings
 *    We look for parties with status "Disconnected" and a recordings[] array.
 *
 * 2. Message-store events — voicemails
 *    When a new voicemail arrives, we fetch unread voicemails for the extension,
 *    download the audio, transcribe it, and add a note to the GHL contact.
 *
 * Pipeline (same for both):
 *   1. Download audio
 *   2. Transcribe with OpenAI Whisper
 *   3. Extract caller name with GPT
 *   4. Find or create GHL contact by phone number
 *   5. Add transcript note
 */
router.post('/ringcentral', async (req, res) => {
  // ── Validation handshake ──────────────────────────────────────────────────
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    console.log('[webhook] RingCentral validation handshake received');
    return res.status(200).set('Validation-Token', validationToken).send();
  }

  // Acknowledge receipt immediately so RC doesn't retry
  res.status(200).json({ received: true });

  // ── Parse event body ──────────────────────────────────────────────────────
  const body = req.body;
  const event = body?.body ?? body;

  if (!event) {
    console.warn('[webhook] Empty event body, skipping');
    return;
  }

  // ── Detect event type ─────────────────────────────────────────────────────
  const isVoicemailEvent =
    (body?.event || '').includes('message-store') ||
    (event.changes || []).some((c) => c.type === 'VoiceMail');

  if (isVoicemailEvent) {
    // ── Voicemail event ───────────────────────────────────────────────────
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
            extensionId,
            messageId: msg.id,
            attachmentId: attachment.id,
            callerPhone,
            calledPhone,
            creationTime: msg.creationTime,
          }).catch((err) => {
            console.error(`[webhook] Voicemail pipeline failed for message ${msg.id}:`, err.message);
          });
        }
      })
      .catch((err) => {
        console.error('[webhook] Failed to fetch voicemails:', err.message);
      });

    return;
  }

  // ── Telephony session event (call recording) ──────────────────────────────
  const parties = event.parties || [];
  const sessionId = event.telephonySessionId || event.sessionId || 'unknown';

  console.log(`[webhook] Telephony session ${sessionId} — ${parties.length} parties`);

  for (const party of parties) {
    const status = party.status?.code;
    const recordings = party.recordings || [];

    if (status !== 'Disconnected' || recordings.length === 0) continue;

    const callerPhone =
      party.from?.phoneNumber || party.from?.extensionNumber || null;
    const calledPhone =
      party.to?.phoneNumber || party.to?.extensionNumber || null;
    const direction = party.direction || 'Unknown'; // Inbound | Outbound
    const durationSeconds =
      party.endTime && party.startTime
        ? Math.round((new Date(party.endTime) - new Date(party.startTime)) / 1000)
        : null;

    console.log(
      `[webhook] ${direction} call — from: ${callerPhone}, to: ${calledPhone}, ` +
      `duration: ${durationSeconds ?? '?'}s, recordings: ${recordings.length}`
    );

    for (const rec of recordings) {
      if (!rec.id) continue;

      processRecording({
        recordingId: rec.id,
        callerPhone,
        calledPhone,
        direction,
        durationSeconds,
        sessionId,
      }).catch((err) => {
        console.error(`[webhook] Pipeline failed for recording ${rec.id}:`, err.message);
      });
    }
  }
});

/**
 * Full pipeline for a single recording.
 */
async function processRecording({
  recordingId,
  callerPhone,
  calledPhone,
  direction,
  durationSeconds,
  sessionId,
}) {
  console.log(`[pipeline] Starting for recording ${recordingId}`);

  // 1. Download the recording
  const { buffer, contentType } = await downloadRecording(recordingId);
  console.log(`[pipeline] Downloaded ${Math.round(buffer.length / 1024)} KB (${contentType})`);

  // 2. Transcribe with Whisper
  const transcript = await transcribe(buffer, contentType);

  // 3. Determine which phone number identifies the outside caller
  //    Inbound → the caller is the "from" party
  //    Outbound → the person we called is the "to" party
  const callerPhone_ = direction === 'Inbound' ? callerPhone : calledPhone;

  if (!callerPhone_) {
    console.warn('[pipeline] No caller phone number available — skipping GHL update');
    return;
  }

  // 4. Check if a GHL contact already exists for this phone number
  const existingContact = await findContactByPhone(callerPhone_);

  let contact;
  if (existingContact) {
    // Contact already exists — do NOT create a duplicate, just use it
    console.log(`[pipeline] Existing contact found (${existingContact.id}) — skipping creation`);
    contact = existingContact;
  } else {
    // No contact found — extract the caller's name from the transcript and create one
    const { firstName, lastName } = await extractCallerName(transcript);
    contact = await createContact(callerPhone_, firstName, lastName);
  }

  // 5. Build and post the transcript note
  const callDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const durationStr =
    durationSeconds != null
      ? `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`
      : 'unknown';

  const noteBody = [
    `Call Transcript — ${direction} Call`,
    `Date: ${callDate}`,
    `From: ${callerPhone || 'unknown'}`,
    `To:   ${calledPhone || 'unknown'}`,
    `Duration: ${durationStr}`,
    `Session ID: ${sessionId}`,
    `Recording ID: ${recordingId}`,
    ``,
    `─── Transcript ───`,
    transcript || '(no speech detected)',
  ].join('\n');

  await addNote(contact.id, noteBody);

  console.log(`[pipeline] Done — note added to GHL contact ${contact.id}`);
}

/**
 * Full pipeline for a single voicemail.
 */
async function processVoicemail({ extensionId, messageId, attachmentId, callerPhone, calledPhone, creationTime }) {
  console.log(`[voicemail] Starting for message ${messageId}`);

  const { buffer, contentType } = await downloadVoicemail(extensionId, messageId, attachmentId);
  console.log(`[voicemail] Downloaded ${Math.round(buffer.length / 1024)} KB (${contentType})`);

  const transcript = await transcribe(buffer, contentType);

  if (!callerPhone) {
    console.warn('[voicemail] No caller phone number — skipping GHL update');
    return;
  }

  const existingContact = await findContactByPhone(callerPhone);
  let contact;
  if (existingContact) {
    console.log(`[voicemail] Existing contact found (${existingContact.id})`);
    contact = existingContact;
  } else {
    const { firstName, lastName } = await extractCallerName(transcript);
    contact = await createContact(callerPhone, firstName, lastName);
  }

  const vmDate = creationTime
    ? new Date(creationTime).toLocaleString('en-US', { timeZone: 'America/New_York' })
    : new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const noteBody = [
    `Voicemail Transcript`,
    `Date: ${vmDate}`,
    `From: ${callerPhone || 'unknown'}`,
    `To:   ${calledPhone || 'unknown'}`,
    `Message ID: ${messageId}`,
    ``,
    `─── Transcript ───`,
    transcript || '(no speech detected)',
  ].join('\n');

  await addNote(contact.id, noteBody);
  console.log(`[voicemail] Done — note added to GHL contact ${contact.id}`);
}

module.exports = router;
