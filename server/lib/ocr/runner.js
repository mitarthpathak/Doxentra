import { OCR_ENGINES } from './engines.js';
import { isPrivacyMode } from '../privacy.js';
import { ocrErrorCode } from './workerClient.js';

export const confidence01 = value => value == null || !Number.isFinite(Number(value)) ? null : Math.min(1, Math.max(0, Number(value)));
const box = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) ? value.map(n => Math.round(Math.max(0, Math.min(1000, n)))) : null;
function cleanRead(read) {
  if (typeof read?.text !== 'string') throw Object.assign(new Error('Invalid OCR output'), { code: 'BAD_OCR_OUTPUT' });
  const item = value => ({ text: String(value.text || '').slice(0, 1000), confidence: confidence01(value.confidence), box: box(value.box),
    ...(Array.isArray(value.characters) ? { characters: value.characters.slice(0, 500).map(c => ({ text: String(c.text || ''), confidence: confidence01(c.confidence), box: box(c.box) })) } : {}) });
  return { text: read.text.slice(0, 20_000), words: (read.words || []).slice(0, 6000).map(item),
    lines: (read.lines || []).slice(0, 2000).map(item), confidenceGranularity: read.confidenceGranularity || 'word' };
}

/** Independent, bounded engine calls; one failure never discards another read. */
export async function runOcrEngines(image, { config, engines = OCR_ENGINES, deadline = Infinity, privacy = isPrivacyMode() }) {
  return Promise.all(config.engines.map(async name => {
    const engine = engines[name];
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    try {
      if (!engine) throw Object.assign(new Error('Unknown OCR engine'), { code: 'UNKNOWN_OCR_ENGINE' });
      if (privacy && !engine.local) throw Object.assign(new Error('Cloud OCR disabled'), { code: 'PRIVACY_MODE' });
      const timeoutMs = Math.min(config.timeoutMs, deadline - Date.now());
      if (timeoutMs <= 0) throw Object.assign(new Error('OCR budget exhausted'), { code: 'OCR_TIMEOUT' });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('OCR timed out'), { code: 'OCR_TIMEOUT' })); }, timeoutMs);
      });
      const read = await Promise.race([Promise.resolve().then(() => engine.extract(image, { timeoutMs, signal: controller.signal })), timeout]);
      return { engine: engine.id || name, status: 'ok', elapsedMs: Date.now() - started, ...cleanRead(read) };
    } catch (err) {
      // OCR text, provider errors and credentials must not enter logs.
      const code = ['UNKNOWN_OCR_ENGINE', 'PRIVACY_MODE', 'BAD_OCR_OUTPUT'].includes(err.code) ? err.code : ocrErrorCode(err);
      console.warn(`[OCR] engine=${name} failed code=${code}`);
      return { engine: name, status: 'failed', error: code, elapsedMs: Date.now() - started, text: '', words: [], lines: [] };
    } finally { clearTimeout(timer); }
  }));
}
