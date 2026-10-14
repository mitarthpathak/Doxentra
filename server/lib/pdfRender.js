import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

// PDF.js' Node canvas factory resolves these same native canvas primitives.
globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;
const require = createRequire(import.meta.url);
const assets = path.dirname(require.resolve('pdfjs-dist/package.json'));

/** Lazy bounded page rendering. A clean text page never calls render(). */
export async function openPdfRenderer(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false,
    standardFontDataUrl: path.join(assets, 'standard_fonts') + path.sep,
    cMapUrl: path.join(assets, 'cmaps') + path.sep, cMapPacked: true,
  });
  const pdf = await task.promise;
  return {
    pageCount: pdf.numPages,
    async render(pageNumber) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      // ~144 DPI for ordinary A4; cap unusual sheets at 4M pixels / 2000px.
      const scale = Math.min(2, 2000 / Math.max(base.width, base.height), Math.sqrt(4_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
        // Noisy scans inflate PNG payloads several-fold. High-quality JPEG
        // preserves readable text while reducing upload time to Gemini.
        return { data: canvas.toBuffer('image/jpeg', 90), mimeType: 'image/jpeg' };
      } finally { page.cleanup(); canvas.width = 1; canvas.height = 1; }
    },
    close: () => task.destroy(),
  };
}
