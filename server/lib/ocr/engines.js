import { recognizeImageBuffer } from '../offlineOcr.js';
import { loadImage } from '@napi-rs/canvas';
import { createOcrWorkerClient } from './workerClient.js';

const paddle = createOcrWorkerClient({ entrypoint: 'lib/ocr/paddleWorker.js' });
export const shutdownPaddleOcr = () => paddle.shutdown();
const paddleExtract = (image, options) => paddle.run({ data: image.data }, options);

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
