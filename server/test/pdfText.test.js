import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyTextLayer, pageTaggedText, prepareDocumentInput, readPdf } from '../lib/pdfText.js';
import { makePdf, makePng } from './helpers/files.js';

const line = 'Invoice No INV-2024-0042 issued by Example Traders Pvt Ltd on 12/03/2024';

test('readPdf keeps page boundaries', async () => {
  const pdf = makePdf([[line, 'Total: Rs. 1,180.00'], ['Page two terms and conditions apply to this invoice.']]);
  const r = await readPdf(pdf);
  assert.equal(r.pageCount, 2);
  assert.equal(r.pages.length, 2);
  assert.match(r.pages[0], /INV-2024-0042/);
  assert.match(r.pages[0], /Total: Rs\. 1,180\.00/);
  assert.match(r.pages[1], /terms and conditions/);
  assert.doesNotMatch(r.pages[0], /terms/);
  assert.equal(r.textLayer, 'digital');
});

test('readPdf flags PDFs without a text layer as scanned', async () => {
  const r = await readPdf(makePdf([[], []]));
  assert.equal(r.pageCount, 2);
  assert.equal(r.textLayer, 'scanned');
  assert.deepEqual(r.lowTextPages, [1, 2]);
});

test('readPdf reports an unreadable PDF as scanned instead of throwing', async () => {
  const r = await readPdf(Buffer.from('%PDF-1.4 broken'));
  assert.equal(r.textLayer, 'scanned');
});

test('classifyTextLayer: digital, mixed and scanned', () => {
  const full = 'x'.repeat(500);
  assert.equal(classifyTextLayer([full, full, full, full]).textLayer, 'digital');
  assert.equal(classifyTextLayer([full, full, full, '']).textLayer, 'mixed');
  assert.equal(classifyTextLayer(['', 'abc', '']).textLayer, 'scanned');
  // Average below 40 chars per page counts as scanned even if one page has a little text.
  assert.equal(classifyTextLayer(['x'.repeat(60), '', '']).textLayer, 'scanned');
});

test('pageTaggedText marks pages and truncates long documents', () => {
  const t = pageTaggedText(['first', 'second']);
  assert.match(t, /=== PAGE 1 ===\nfirst/);
  assert.match(t, /=== PAGE 2 ===\nsecond/);
  const long = pageTaggedText(['a'.repeat(80), 'b'.repeat(80)], 100);
  assert.ok(long.length < 200);
  assert.match(long, /truncated/);
});

test('prepareDocumentInput picks the text path, the OCR path or both', async () => {
  const digital = await prepareDocumentInput({ buffer: makePdf([[line, line]]), kind: 'pdf' });
  assert.equal(digital.mode, 'text');
  assert.equal(digital.ocrUsed, false);
  assert.match(digital.text, /=== PAGE 1 ===/);
  assert.equal(digital.file, undefined);

  const scanned = await prepareDocumentInput({ buffer: makePdf([[]]), kind: 'pdf' });
  assert.equal(scanned.mode, 'file');
  assert.equal(scanned.ocrUsed, true);
  assert.equal(scanned.file.mimeType, 'application/pdf');

  const mixed = await prepareDocumentInput({ buffer: makePdf([[line, line], [line, line], []]), kind: 'pdf' });
  assert.equal(mixed.mode, 'text+file');
  assert.equal(mixed.ocrUsed, true);
  assert.deepEqual(mixed.lowTextPages, [3]);

  const image = await prepareDocumentInput({ buffer: makePng(), kind: 'image', mimeType: 'image/png' });
  assert.deepEqual([image.mode, image.ocrUsed, image.pageCount, image.file.mimeType], ['file', true, 1, 'image/png']);
});

test('the existing sample PDF is detected as digital', async () => {
  const r = await readPdf(readFileSync(new URL('./fixtures/sample.pdf', import.meta.url)));
  assert.ok(r.pageCount >= 1);
  assert.equal(r.textLayer, 'digital');
});

test('garbled text layers (broken Hindi font encoding) are detected and read from the file', async () => {
  const { isGarbledText } = await import('../lib/pdfText.js');
  assert.ok(isGarbledText('आदश\u0000 पि\u0000लक स्कू ल'));
  assert.ok(isGarbledText('िदनांक / Date: 02/01/2024 िवषय: वािष'));
  assert.ok(!isGarbledText('दिनांक / Date: 02/01/2024 विषय: वार्षिक परीक्षा'));
  assert.ok(!isGarbledText('Plain English text with no problems at all.'));
  const notice = readFileSync(new URL('../../samples/g-notice-bilingual-hindi-english.pdf', import.meta.url));
  const input = await prepareDocumentInput({ buffer: notice, kind: 'pdf' });
  assert.equal(input.mode, 'text+file');
  assert.equal(input.ocrUsed, true);
  assert.deepEqual(input.unreliablePages, [1]);
  assert.match(input.text, /=== PAGE 1 ===\n\(text layer unreadable/, 'garbled text is not sent to the model');
  assert.doesNotMatch(input.text, /पि/);
  assert.doesNotMatch(input.pages[0], /\u0000/);
});
