import { parentPort, workerData } from 'node:worker_threads';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { ocrErrorCode } from './workerClient.js';

let worker;
parentPort.on('message', async ({ data: image }) => {
  try {
    if (!worker) {
      // Do not let a missing bundled model trigger a network download.
      await access(path.join(workerData.langPath, 'eng.traineddata'));
      worker = await createWorker('eng', 1, {
        langPath: workerData.langPath, cacheMethod: 'none', gzip: false,
      });
    }
    const { data } = await worker.recognize(Buffer.from(image));
    const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(p => p.lines || []));
    parentPort.postMessage({ result: {
      text: String(data.text || '').trim(), confidence: Number(data.confidence) || 0,
      lines: lines.map(line => ({ text: String(line.text || '').trim(), bbox: line.bbox, confidence: Number(line.confidence) || 0 })),
      words: (data.words || lines.flatMap(line => line.words || [])).map(word => ({
        text: word.text, bbox: word.bbox, confidence: Number(word.confidence) || 0,
        symbols: (word.symbols || []).map(s => ({ text: s.text, bbox: s.bbox, confidence: Number(s.confidence) || 0 })),
      })),
    } });
  } catch (err) {
    parentPort.postMessage({ error: { code: ocrErrorCode(err) } });
  }
});
