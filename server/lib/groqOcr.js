// Vision-only backup for pages Gemini could not read. Never used for text reasoning.
import { forbidCloud } from './privacy.js';
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export const isGroqOcrConfigured = () => Boolean(process.env.GROQ_API_KEY?.trim());

export async function readPageWithGroq(image, prompt, { deadline = Date.now() + 15_000, fetchImpl = fetch } = {}) {
  forbidCloud();
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw Object.assign(new Error('Groq OCR is not configured'), { code: 'NO_GROQ_KEY' });
  const remaining = Math.min(15_000, deadline - Date.now() - 500);
  if (remaining < 1000) throw Object.assign(new Error('No time remains for backup OCR'), { code: 'AI_TIMEOUT' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_VISION_MODEL?.trim() || DEFAULT_MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: `${prompt}\nReturn only a JSON object with text and visibleFields.` },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data.toString('base64')}` } },
        ] }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_completion_tokens: 4096,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Provider response bodies can contain request data. Keep errors and logs metadata-only.
      throw Object.assign(new Error(`Groq OCR returned HTTP ${response.status}`), { status: response.status, code: 'GROQ_OCR_FAILED' });
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw Object.assign(new Error('Groq OCR returned no text'), { code: 'BAD_AI_OUTPUT' });
    }
    return content;
  } catch (err) {
    if (controller.signal.aborted) throw Object.assign(new Error('Groq OCR timed out'), { code: 'AI_TIMEOUT' });
    throw err;
  } finally { clearTimeout(timer); }
}
