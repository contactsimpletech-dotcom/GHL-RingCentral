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
 * Extract the caller's first and last name from a call transcript using GPT.
 *
 * The agent typically says the caller's name naturally during the call
 * (e.g. "Nice to meet you, John Smith" or "So that's under Jane Doe?").
 * Returns { firstName, lastName } — either may be null if not found.
 */
async function extractCallerName(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    return { firstName: null, lastName: null };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            "You are extracting a caller's name from a phone call transcript. " +
            "The agent (the person who answered) may say the caller's name naturally " +
            "(e.g. 'Nice to meet you, John', 'Can I get your name?' 'John Smith', " +
            "'Let me pull up your account, Sarah', 'So that is for Jane Doe?'). " +
            "Return ONLY a JSON object with exactly two keys: \"firstName\" and \"lastName\". " +
            "If you cannot find a clear caller name, set both to null. " +
            "Do NOT include the agent's own name — only the caller's name.",
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const firstName = parsed.firstName || null;
    const lastName = parsed.lastName || null;

    console.log(`[transcription] Extracted caller name: "${firstName} ${lastName}"`);
    return { firstName, lastName };
  } catch (err) {
    console.error('[transcription] Name extraction failed:', err.message);
    return { firstName: null, lastName: null };
  }
}

module.exports = { transcribe, extractCallerName };
