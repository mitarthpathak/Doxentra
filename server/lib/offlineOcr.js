import { loadImage } from '@napi-rs/canvas';
import { openPdfRenderer } from './pdfRender.js';
import { createOcrWorkerClient, ocrRuntimePath } from './ocr/workerClient.js';

const tesseract = createOcrWorkerClient({
  entrypoint: 'lib/ocr/tesseractWorker.js',
  workerData: () => ({ langPath: ocrRuntimePath('data/tessdata') }),
});

export const shutdownOfflineOcr = () => tesseract.shutdown();

/** Recognize an image locally; startup, queueing and recognition share one budget. */
export async function recognizeImageBuffer(imageBuffer, options = {}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new TypeError('A nonempty image Buffer is required.');
  await loadImage(imageBuffer);
  return tesseract.run({ data: imageBuffer }, { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
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
