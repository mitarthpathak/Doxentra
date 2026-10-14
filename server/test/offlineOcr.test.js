import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { recognizeImageBuffer, recognizeScannedPdf, shutdownOfflineOcr } from '../lib/offlineOcr.js';
import { OCR_ENGINES, shutdownPaddleOcr } from '../lib/ocr/engines.js';

function sampleImage(mimeType = 'image/png') {
  const canvas = createCanvas(900, 180);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 900, 180);
  context.fillStyle = '#000';
  context.font = 'bold 52px Arial';
  context.fillText('INVOICE 12345', 25, 110);
  return canvas.toBuffer(mimeType);
}

test.after(async () => { await shutdownOfflineOcr(); await shutdownPaddleOcr(); });

test('two independent local engines read a real image and expose native confidence evidence', async () => {
  const image = { data: sampleImage(), mimeType: 'image/png' };
  const [tesseract, paddle] = await Promise.all([OCR_ENGINES.tesseract.extract(image, { timeoutMs: 30_000 }), OCR_ENGINES.paddle.extract(image, { timeoutMs: 30_000 })]);
  assert.match(tesseract.text, /INVOICE\s*12345/); assert.match(paddle.text, /INVOICE\s*12345/);
  assert.ok(tesseract.words.some(w => w.characters?.length && w.confidence > 0.5));
  assert.ok(paddle.lines.some(l => l.confidence > 0.5 && l.box));
  assert.equal(paddle.confidenceGranularity, 'line');
});

test('local image OCR reads text and lines without HTTP or HTTPS requests', async () => {
  const original = { fetch: globalThis.fetch, httpGet: http.get, httpRequest: http.request, httpsGet: https.get, httpsRequest: https.request };
  let networkCalls = 0;
  const blocked = () => { networkCalls++; throw new Error('OCR attempted network access'); };
  globalThis.fetch = blocked;
  http.get = blocked; http.request = blocked;
  https.get = blocked; https.request = blocked;
  try {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
      const result = await recognizeImageBuffer(sampleImage(mimeType));
      assert.match(result.text, /INVOICE 12345/, mimeType);
      assert.ok(result.confidence > 50, mimeType);
      assert.ok(result.lines.some(line => /INVOICE 12345/.test(line.text) && line.bbox), mimeType);
    }
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = original.fetch;
    http.get = original.httpGet; http.request = original.httpRequest;
    https.get = original.httpsGet; https.request = original.httpsRequest;
  }
});

test('selected scanned PDF pages are OCRed and returned in page order', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([900, 180]);
  const image = await pdf.embedPng(sampleImage());
  const scan = pdf.addPage([900, 180]);
  scan.drawImage(image, { x: 0, y: 0, width: 900, height: 180 });
  const scan2 = pdf.addPage([900, 180]);
  scan2.drawImage(image, { x: 0, y: 0, width: 900, height: 180 });
  const progress = [];
  const result = await recognizeScannedPdf(Buffer.from(await pdf.save()), { pageNumbers: [2, 3], onPage: (page, completed) => progress.push([page, completed]) });
  assert.equal(result.pageCount, 3);
  assert.deepEqual(progress, [[2, 1], [3, 2]]);
  assert.equal(result.pages[0], '');
  assert.match(result.pages[1], /INVOICE 12345/);
  assert.equal(result.ocrUsed, true);
});

test('invalid image buffers fail clearly and do not poison the worker', async () => {
  await assert.rejects(recognizeImageBuffer(Buffer.from('not an image')));
  assert.match((await recognizeImageBuffer(sampleImage())).text, /INVOICE 12345/);
});
