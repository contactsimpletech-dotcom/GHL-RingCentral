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
 */
async function extractCallerInfo(transcript) {
  if (!transcript || transcript.trim().length === 0) return {};

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You extract caller information from a phone call or voicemail transcript.
Extract only what the CALLER says (not the agent/receiver). Return a JSON object with these keys (null if not found):

- firstName: caller's first name
- lastName: caller's last name  
- phone: caller's phone number they mention (digits only, e.g. "9092542546")
- email: caller's email (reconstruct from speech e.g. "kevin at brightstarthivegan dot com" -> "kevin@brightstarthivegan.com")
- jobTitle: their job title or role (e.g. "owner", "CEO", "marketing director")
- industry: their industry or business sector (e.g. "food restaurant", "construction", "tech")
- serviceIssue: any service problem or reason they are calling (e.g. "payment processor not working")
- networkGroup: any networking group they belong to (e.g. "Team Network", "BNI")
- chapterChamber: any chapter or chamber name (e.g. "You Get It", "Upland Chamber")
- businessName: their company or business name (e.g. "Bright Star Thai Vegan")
- networkingEventName: any specific networking event name
- website: their website (reconstruct from speech e.g. "brightstarthivegan dot com" -> "brightstarthivegan.com")
- city: their city if mentioned
- state: their state if mentioned (full name or abbreviation)
- postalCode: their zip/postal code if mentioned
- country: their country if mentioned

Return ONLY the JSON object.`,
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