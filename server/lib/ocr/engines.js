import { Worker } from 'node:worker_threads';
import { recognizeImageBuffer } from '../offlineOcr.js';
import { loadImage } from '@napi-rs/canvas';

let paddleWorker;
let paddleQueue = Promise.resolve();
let idle;
export async function shutdownPaddleOcr() {
  clearTimeout(idle);
  const current = paddleWorker;
  paddleWorker = null;
  await current?.terminate();
}

function paddleExtract(image, { timeoutMs = 20_000, signal } = {}) {
  const operation = paddleQueue.then(async () => {
    if (signal?.aborted) throw Object.assign(new Error('OCR cancelled'), { code: 'OCR_TIMEOUT' });
    clearTimeout(idle);
    const worker = paddleWorker ||= new Worker(new URL('./paddleWorker.js', import.meta.url), {
      execArgv: [],
    });
    if (!worker.listenerCount('error')) worker.on('error', () => {
      if (paddleWorker === worker) { paddleWorker = null; clearTimeout(idle); }
      console.warn('[OCR] engine=paddle worker failed');
    });
    worker.ref();
    try {
      return await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exited); signal?.removeEventListener('abort', aborted); };
        const message = payload => { cleanup(); payload.error ? reject(Object.assign(new Error('Paddle OCR failed'), payload.error)) : resolve(payload.result); };
        const error = () => { cleanup(); reject(Object.assign(new Error('Paddle OCR worker failed'), { code: 'PADDLE_OCR_FAILED' })); };
        const exited = () => error();
        const aborted = () => { cleanup(); reject(Object.assign(new Error('Paddle OCR timed out'), { code: 'OCR_TIMEOUT' })); };
        const timer = setTimeout(aborted, timeoutMs);
        signal?.addEventListener('abort', aborted, { once: true });
        worker.once('message', message); worker.once('error', error); worker.once('exit', exited);
        worker.postMessage({ data: image.data });
      });
    } catch (err) { await shutdownPaddleOcr(); throw err; }
    finally { idle = setTimeout(() => { void shutdownPaddleOcr(); }, 60_000); idle.unref?.(); worker.unref(); }
  });
  paddleQueue = operation.catch(() => {});
  return operation;
}

async function tesseractExtract(image, options) {
  const [read, decoded] = await Promise.all([recognizeImageBuffer(image.data, options), loadImage(image.data)]);
  const box = b => b ? [b.y0 / decoded.height * 1000, b.x0 / decoded.width * 1000,
    b.y1 / decoded.height * 1000, b.x1 / decoded.width * 1000].map(Math.round) : null;
  return { text: read.text,
    lines: read.lines.map(l => ({ ...l, confidence: l.confidence / 100, box: box(l.bbox) })),
    words: read.words.map(w => ({ text: w.text, confidence: w.confidence / 100, box: box(w.bbox),
      characters: w.symbols.map(s => ({ text: s.text, confidence: s.confidence / 100, box: box(s.bbox) })) })),
    confidenceGranularity: 'character',
  };
}

/** Each engine implements extract({data: Buffer, mimeType}, {timeoutMs, signal}).
 * Boxes are [ymin,xmin,ymax,xmax] in 0-1000; confidences are 0-1 or null.
 * Custom registries can be supplied to runOcrEngines without changing the pipeline.
 */
export const OCR_ENGINES = {
  tesseract: { id: 'tesseract', local: true, extract: tesseractExtract },
  paddle: { id: 'paddle', local: true, extract: paddleExtract },
};
