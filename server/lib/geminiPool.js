import { GoogleGenAI } from '@google/genai';

export const isGeminiRateLimit = error => Number(error?.status) === 429 || error?.code === 'AI_QUOTA_EXHAUSTED' ||
  /RESOURCE_EXHAUSTED|rate.?limit|quota.{0,40}(?:exceed|exhaust)/i.test(String(error?.message || ''));

/** RPD resets at midnight Pacific, including DST transitions. */
export function nextPacificMidnight(now) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(format.formatToParts(now).map(p => [p.type, p.value]));
  const localTarget = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' });
  const offset = zone.formatToParts(localTarget + 8 * 3600_000).find(p => p.type === 'timeZoneName').value;
  const [, sign, hours, minutes] = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
  return localTarget - (sign === '+' ? 1 : -1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}

/** Round robin is process-local; cooldowns are scoped to a key AND model. */
export class GeminiKeyPool {
  constructor(keys, { createClient = key => new GoogleGenAI({ apiKey: key }), now = Date.now } = {}) {
    this.entries = [...new Set(keys.filter(Boolean))].map((key, i) => ({
      id: `key-${i + 1}`, client: createClient(key), cooldowns: new Map(), disabled: false,
    }));
    this.cursor = 0;
    this.now = now;
  }
  available(model, excluded = new Set()) {
    return this.entries.filter(e => !e.disabled && !excluded.has(e.id) && (e.cooldowns.get(model) || 0) <= this.now());
  }
  take(model, excluded = new Set(), preferredId) {
    const preferred = this.entries.findIndex(e => e.id === preferredId);
    const start = preferred >= 0 ? preferred : this.cursor;
    for (let i = 0; i < this.entries.length; i++) {
      const index = (start + i) % this.entries.length;
      const entry = this.entries[index];
      if (!entry.disabled && !excluded.has(entry.id) && (entry.cooldowns.get(model) || 0) <= this.now()) {
        // A preferred slot was already allocated by the page scheduler.
        if (!preferredId) this.cursor = (index + 1) % this.entries.length;
        return entry;
      }
    }
    return null;
  }
  cool(entry, model, error) {
    const message = String(error?.message || '');
    const seconds = Number(message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1]);
    const header = Number(error?.headers?.get?.('retry-after') ?? error?.headers?.['retry-after']);
    const hinted = (seconds || header || 0) * 1000;
    const daily = /per.?day|daily|requestsperday|tokensperday/i.test(message);
    const ms = Math.min(86_400_000, Math.max(1000, hinted || (daily ? nextPacificMidnight(this.now()) - this.now() : 60_000)));
    entry.cooldowns.set(model, this.now() + ms);
  }
  nextReadyAt(models, owner) {
    const times = this.entries.filter(e => !e.disabled && (!owner || e === owner))
      .flatMap(e => models.map(model => Math.max(this.now(), e.cooldowns.get(model) || 0)));
    return times.length ? Math.min(...times) : null;
  }
}

export function configuredGeminiKeys(env = process.env) {
  const numbered = Object.keys(env).filter(k => /^GEMINI_API_KEY_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1)));
  return [...new Set([env.GEMINI_API_KEY?.trim(), ...numbered.map(k => env[k]?.trim())].filter(Boolean))];
}

let pool;
let signature;
export function getGeminiPool() {
  const keys = configuredGeminiKeys();
  const next = JSON.stringify(keys);
  if (!pool || signature !== next) { pool = new GeminiKeyPool(keys); signature = next; }
  return pool;
}
