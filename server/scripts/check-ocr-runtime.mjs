import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv.includes('--isolated-child')) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { OCR_ENGINES, shutdownPaddleOcr } = await import('../lib/ocr/engines.js');
  const { shutdownOfflineOcr } = await import('../lib/offlineOcr.js');
  try {
    const canvas = createCanvas(900, 180);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 900, 180);
    ctx.fillStyle = 'black'; ctx.font = 'bold 52px Arial';
    ctx.fillText('INVOICE 12345', 25, 110);
    const image = { data: canvas.toBuffer('image/png'), mimeType: 'image/png' };
    const results = await Promise.allSettled(Object.entries(OCR_ENGINES).map(async ([name, engine]) => {
      const started = Date.now();
      const read = await engine.extract(image, { timeoutMs: 30_000 });
      assert.match(read.text, /INVOICE\s*12345/);
      console.log(`[OCR runtime check] ${name}: PASS (${Date.now() - started}ms)`);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const { PDFDocument } = await import('pdf-lib');
    const { openPdfRenderer } = await import(pathToFileURL(path.join(process.env.DOXENTRA_OCR_RUNTIME_DIR, 'lib/pdfRender.js')).href);
    const pdf = await PDFDocument.create();
    const picture = await pdf.embedPng(image.data);
    pdf.addPage([900, 180]).drawImage(picture, { x: 0, y: 0, width: 900, height: 180 });
    const renderer = await openPdfRenderer(Buffer.from(await pdf.save()));
    try {
      const page = await renderer.render(1);
      const read = await OCR_ENGINES.tesseract.extract(page, { timeoutMs: 30_000 });
      assert.match(read.text, /INVOICE\s*12345/);
      console.log('[OCR runtime check] isolated scanned PDF: PASS');
    } finally { await renderer.close(); }
  } finally { await Promise.all([shutdownOfflineOcr(), shutdownPaddleOcr()]); }
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'doxentra-ocr-runtime-'));
  try {
    // Outside the repo, missing worker modules cannot fall back to the
    // developer's full node_modules tree. A child process also releases native
    // DLL handles before the parent removes the temporary directory on Windows.
    const isolated = path.join(temporary, 'runtime');
    await cp(path.join(root, '.ocr-runtime'), isolated, { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
        env: { ...process.env, DOXENTRA_OCR_RUNTIME_DIR: isolated }, stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Isolated OCR runtime failed')));
    });
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('doxentra-ocr-runtime-')) throw new Error('Invalid OCR check directory');
    await rm(temporary, { recursive: true, force: true });
  }
}
