const express = require('express');
const { downloadRecording } = require('../services/ringcentral');
const { transcribe, extractCallerName } = require('../services/transcription');
const { findContactByPhone, createContact, addNote } = require('../services/ghl');

const router = express.Router();

/**
 * POST /webhook/ringcentral
 *
 * Receives RingCentral telephony session event notifications.
 *
 * RingCentral first validates the endpoint by sending a request with a
 * "Validation-Token" header — we echo it back immediately.
 *
 * After validation, RC sends JSON event bodies as call state changes.
 * We look for parties with:
 *   - status.code === "Disconnected"   (call ended)
 *   - recordings[] with entries        (recording is attached)
 *
 * Pipeline per recording:
 *   1. Download audio from RingCentral
 *   2. Transcribe with OpenAI Whisper
 *   3. Use GPT to extract the caller's name from the transcript
 *   4. Search GHL for an existing contact by caller phone number
 *      - Found    → skip creation, just add the transcript as a note
 *      - Not found → create a new contact using the extracted name, then add note
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

  const parties = event.parties || [];
  const sessionId = event.telephonySessionId || event.sessionId || 'unknown';

  console.log(`[webhook] Telephony session ${sessionId} — ${parties.length} parties`);

  // ── Process each disconnected party with a recording ──────────────────────
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

module.exports = router;
