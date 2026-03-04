const { OpenAI, toFile } = require('openai');
const config = require('../config');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 */
async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  const ext = contentType.includes('wav') ? 'wav' : 'mp3';
  const file = await toFile(audioBuffer, `recording.${ext}`, { type: contentType });
  console.log(`[transcription] Sending ${Math.round(audioBuffer.length / 1024)} KB to Whisper...`);
  const response = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'text',
  });
  const text = typeof response === 'string' ? response : response.text;
  console.log(`[transcription] Transcribed ${text.length} characters`);
  return text;
}

/**
 * Extract caller name, email, and phone number from a call transcript using GPT.
 * Returns { firstName, lastName, email, phone }
 */
async function extractCallerInfo(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    return { firstName: null, lastName: null, email: null, phone: null };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            "You are extracting caller information from a phone call transcript. " +
            "Look for: the caller's name (not the agent's), their email address, and their phone number. " +
            "Email addresses are often spelled out letter by letter or said naturally like 'kevin at demo dot com'. " +
            "Phone numbers may be read digit by digit. " +
            "Return ONLY a JSON object with exactly four keys: \"firstName\", \"lastName\", \"email\", \"phone\". " +
            "Reconstruct emails like 'kevin at demo dot com' into 'kevin@demo.com'. " +
            "Reconstruct phone numbers into digits only e.g. '9096036030'. " +
            "Set any field to null if not found.",
        },
        { role: 'user', content: transcript },
      ],
    });

    const raw = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    console.log(`[transcription] Extracted caller info:`, JSON.stringify(parsed));
    return {
      firstName: parsed.firstName || null,
      lastName: parsed.lastName || null,
      email: parsed.email || null,
      phone: parsed.phone || null,
    };
  } catch (err) {
    console.error('[transcription] Info extraction failed:', err.message);
    return { firstName: null, lastName: null, email: null, phone: null };
  }
}

// Legacy wrapper kept for backward compatibility
async function extractCallerName(transcript) {
  const { firstName, lastName } = await extractCallerInfo(transcript);
  return { firstName, lastName };
}

module.exports = { transcribe, extractCallerName, extractCallerInfo };