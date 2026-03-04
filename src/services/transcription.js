const { OpenAI, toFile } = require('openai');
const config = require('../config');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  const ext = contentType.includes('wav') ? 'wav' : 'mp3';
  const file = await toFile(audioBuffer, `recording.${ext}`, { type: contentType });
  console.log(`[transcription] Sending ${Math.round(audioBuffer.length / 1024)} KB to Whisper...`);
  const response = await openai.audio.transcriptions.create({ file, model: 'whisper-1', response_format: 'text' });
  const text = typeof response === 'string' ? response : response.text;
  console.log(`[transcription] Transcribed ${text.length} characters`);
  return text;
}

/**
 * Extract all relevant caller fields from a transcript using GPT.
 * Maps to GHL custom fields.
 */
async function extractCallerInfo(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    return {};
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You extract caller information from a phone call or voicemail transcript.
Extract only what the CALLER says (not the agent). Return a JSON object with these keys (set to null if not found):
- firstName: caller's first name
- lastName: caller's last name
- phone: caller's phone number (digits only, e.g. "9096036030")
- email: caller's email (reconstruct from speech, e.g. "kevin at demo dot com" → "kevin@demo.com")
- jobTitle: their job title or role
- industry: their industry or business sector
- serviceIssue: any service problem, issue, or reason they are calling
- networkGroup: any networking group they mention
- chapterChamber: any chapter or chamber of commerce they mention
- businessName: their company or business name
- networkingEventName: any networking event they mention
- website: their website (reconstruct from speech, e.g. "contactsimpletech dot com" → "contactsimpletech.com")
Return ONLY the JSON object, no extra text.`,
        },
        { role: 'user', content: transcript },
      ],
    });

    const raw = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    console.log('[transcription] Extracted caller info:', JSON.stringify(parsed));
    return parsed;
  } catch (err) {
    console.error('[transcription] Info extraction failed:', err.message);
    return {};
  }
}

// Legacy wrapper
async function extractCallerName(transcript) {
  const info = await extractCallerInfo(transcript);
  return { firstName: info.firstName || null, lastName: info.lastName || null };
}

module.exports = { transcribe, extractCallerName, extractCallerInfo };