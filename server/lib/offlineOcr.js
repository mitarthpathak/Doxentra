import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { loadImage } from '@napi-rs/canvas';
import { openPdfRenderer } from './pdfRender.js';

const tessdata = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/tessdata');
const IDLE_MS = 60_000;
const OCR_TIMEOUT_MS = 60_000;
let workerPromise;
let queue = Promise.resolve();
let idleTimer;
let handlingSignals = false;

function onInterrupt() { void shutdownOfflineOcr().catch(() => {}).finally(() => process.exit(130)); }
function onTerminate() { void shutdownOfflineOcr().catch(() => {}).finally(() => process.exit(143)); }

function watchShutdown() {
  if (handlingSignals) return;
  handlingSignals = true;
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
}

async function worker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Fail closed before Tesseract can use its default remote language path.
      await access(path.join(tessdata, 'eng.traineddata'));
      const ready = await createWorker('eng', 1, { langPath: tessdata, cachePath: tessdata, cacheMethod: 'readOnly', gzip: false });
      watchShutdown();
      return ready;
    })().catch(err => { workerPromise = undefined; throw err; });
  }
  return workerPromise;
}

export async function shutdownOfflineOcr() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const pending = workerPromise;
  workerPromise = undefined;
  if (pending) await pending.then(w => w.terminate(), () => {});
  if (handlingSignals) {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    handlingSignals = false;
  }
}

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void shutdownOfflineOcr(); }, IDLE_MS);
  idleTimer.unref?.();
}

function exclusive(operation) {
  const current = queue.then(async () => {
    clearTimeout(idleTimer);
    try { return await operation(await worker()); }
    finally { scheduleIdleShutdown(); }
  });
  queue = current.catch(() => {});
  return current;
}

/** Recognize an image entirely from memory using the bundled English model. */
export async function recognizeImageBuffer(imageBuffer, options = {}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new TypeError('A nonempty image Buffer is required.');
  // Tesseract's image decoder can emit an uncaught worker error for corrupt bytes.
  await loadImage(imageBuffer);
  const timeoutMs = options.timeoutMs ?? OCR_TIMEOUT_MS;
  return exclusive(async w => {
    if (options.signal?.aborted) throw Object.assign(new Error('Local OCR cancelled.'), { code: 'OCR_TIMEOUT' });
    let timer;
    let cancel;
    try {
      const recognition = w.recognize(imageBuffer);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local OCR timed out.')), timeoutMs);
        timer.unref?.();
        cancel = () => reject(Object.assign(new Error('Local OCR cancelled.'), { code: 'OCR_TIMEOUT' }));
        options.signal?.addEventListener('abort', cancel, { once: true });
      });
      const { data } = await Promise.race([recognition, timeout]);
      const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(p => p.lines || []));
      return {
        text: String(data.text || '').trim(),
        confidence: Number(data.confidence) || 0,
        lines: lines.map(line => ({ text: String(line.text || '').trim(), bbox: line.bbox, confidence: Number(line.confidence) || 0 })),
        words: (data.words || lines.flatMap(line => line.words || [])).map(word => ({
          text: word.text, bbox: word.bbox, confidence: Number(word.confidence) || 0,
          symbols: (word.symbols || []).map(s => ({ text: s.text, bbox: s.bbox, confidence: Number(s.confidence) || 0 })),
        })),
      };
    } catch (err) {
      // A timed-out or failed worker may still be busy; discard it before reuse.
      await shutdownOfflineOcr();
      throw err;
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
  });
}

/** Render selected PDF pages locally and OCR them. Page numbers are 1-based. */
export async function recognizeScannedPdf(pdfBuffer, options = {}) {
  const renderer = await openPdfRenderer(pdfBuffer);
  try {
    const pages = Array(renderer.pageCount).fill('');
    const selected = options.pageNumbers || Array.from({ length: renderer.pageCount }, (_, i) => i + 1);
    let completed = 0;
    for (const pageNumber of selected) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > renderer.pageCount) throw new RangeError('Invalid PDF page number.');
      const image = await renderer.render(pageNumber);
      pages[pageNumber - 1] = (await recognizeImageBuffer(image.data, options)).text;
      await options.onPage?.(pageNumber, ++completed);
    }
    return { pages, pageCount: renderer.pageCount, textLayer: 'scanned', ocrUsed: true };
  } finally { await renderer.close(); }
}
