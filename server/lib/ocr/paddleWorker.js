import { parentPort } from 'node:worker_threads';
import { access } from 'node:fs/promises';
import Ocr from '@gutenye/ocr-node';
import models from '@gutenye/ocr-models/node';
import { loadImage } from '@napi-rs/canvas';
import http from 'node:http';
import https from 'node:https';

// This engine is local even when a future dependency tries to fetch an asset.
const noNetwork = () => { throw Object.assign(new Error('Local OCR network access is disabled'), { code: 'OCR_NETWORK_DISABLED' }); };
globalThis.fetch = noNetwork;
http.get = http.request = https.get = https.request = noNetwork;

let engine;
parentPort.on('message', async ({ data }) => {
  try {
    if (!engine) {
      // All models are installed with npm. Never fetch models at runtime.
      await Promise.all(Object.values(models).map(file => access(file)));
      engine = await Ocr.create({ models, onnxOptions: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
    }
    const image = await loadImage(Buffer.from(data));
    // The pinned Node build accepts encoded Buffers through its Sharp backend.
    const result = await engine.detect(Buffer.from(data));
    const resizedWidth = Math.ceil(image.width / 32) * 32;
    const resizedHeight = Math.ceil(image.height / 32) * 32;
    const scale = Math.min(resizedWidth / image.width, resizedHeight / image.height);
    const left = (resizedWidth - image.width * scale) / 2;
    const top = (resizedHeight - image.height * scale) / 2;
    const lines = result.map(line => {
      const frame = line.frame;
      const box = line.box || (frame ? [[frame.left, frame.top], [frame.left + frame.width, frame.top + frame.height]] : null);
      const xs = box?.map(p => p[0]); const ys = box?.map(p => p[1]);
      return { text: line.text, confidence: line.score ?? line.mean ?? null,
        box: box ? [(Math.min(...ys) - top) / (image.height * scale) * 1000, (Math.min(...xs) - left) / (image.width * scale) * 1000,
          (Math.max(...ys) - top) / (image.height * scale) * 1000, (Math.max(...xs) - left) / (image.width * scale) * 1000].map(n => Math.round(Math.max(0, Math.min(1000, n)))) : null };
    });
    parentPort.postMessage({ result: { text: lines.map(l => l.text).join('\n'), lines, words: [], confidenceGranularity: 'line' } });
  } catch (err) {
    // Do not pass library errors that may include image text or filesystem paths.
    parentPort.postMessage({ error: { code: err.code || 'PADDLE_OCR_FAILED' } });
  }
});
