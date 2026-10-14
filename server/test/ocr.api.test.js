import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { shutdownOfflineOcr } from '../lib/offlineOcr.js';
import { shutdownPaddleOcr } from '../lib/ocr/engines.js';
import { makePdf } from './helpers/files.js';

process.env.MONGO_URI = ''; process.env.VERCEL = '1';
process.env.OCR_CROSSCHECK_ENABLED = '1'; process.env.OCR_MAX_REPROCESS_FIELDS = '2';
// Require review deterministically, even for a very clean synthetic image.
process.env.OCR_DIGIT_CONFIDENCE_THRESHOLD = '1';
const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const { getDocument } = await import('../lib/db.js');
const { withPrivacyMode } = await import('../lib/privacy.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const guestId = 'ocr_review_api_guest_123456789';
const headers = { 'x-guest-id': guestId, 'x-processing-mode': 'privacy' };
let aiCalls = 0;
test.before(() => setGeminiClient({ models: { async generateContent() { aiCalls++; throw new Error('Cloud AI must not be called'); } } }));
test.after(async () => { setGeminiClient(null); server.close(); await shutdownOfflineOcr(); await shutdownPaddleOcr(); });
const request = async (path, init = {}) => {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  return { status: response.status, body: await response.json() };
};
const image = () => {
  const canvas = createCanvas(1000, 380); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 380); ctx.fillStyle = '#000'; ctx.font = '38px Arial';
  ['TAX INVOICE', 'Invoice number: LOCAL-987', 'Seller name: Demo Co', 'Total: INR 500'].forEach((line, i) => ctx.fillText(line, 30, 65 + i * 80));
  return canvas.toBuffer('image/png');
};
const upload = async (bytes, name = 'ocr.png', type = 'image/png') => {
  const form = new FormData(); form.append('files', new Blob([bytes], { type }), name);
  return request('/extract', { method: 'POST', body: form });
};

test('real two-engine upload produces additive schema and a working audited manual review API', async () => {
  const response = await upload(image());
  assert.equal(response.status, 200);
  const doc = response.body.documents[0];
  assert.deepEqual(doc.ocr.engines, ['tesseract', 'paddle']);
  assert.ok(doc.ocr.pages[0].engines.every(e => e.status === 'ok'));
  assert.equal(doc.ocr.agreementIsGuarantee, false);
  const amount = doc.fields.find(f => f.key === 'total_amount');
  assert.equal(amount.field, 'total_amount'); assert.equal(amount.status, 'needs_review'); assert.equal(amount.value, null);
  assert.ok(amount.candidates.some(c => c.engine === 'tesseract'));
  assert.ok(amount.candidates.some(c => c.engine === 'paddle'));
  assert.ok(amount.candidates.some(c => c.attempt === 1));
  assert.ok(doc.needs_review.some(item => item.field === 'total_amount' && item.box));
  const changed = await request(`/documents/${doc.id}/fields/total_amount`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'correct', value: 'INR 500', note: 'Checked the source image.' }) });
  assert.equal(changed.status, 200);
  const corrected = changed.body.fields.find(f => f.key === 'total_amount');
  assert.equal(corrected.status, 'accepted'); assert.equal(corrected.confidence, 1); assert.equal(corrected.ocr.manualReview.action, 'correct');
  assert.ok(!changed.body.needs_review.some(item => item.field === 'total_amount'));
  assert.equal(changed.body.auditEntry.action, 'correct');
  const reopened = await request(`/documents/${doc.id}/fields/total_amount`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) });
  assert.equal(reopened.body.fields.find(f => f.key === 'total_amount').status, 'needs_review');
  const saved = await withPrivacyMode(true, () => getDocument(doc.id, { guestId }));
  assert.ok(saved.extraction.fields.some(f => f.status === 'needs_review'));
  const exported = await request(`/documents/${doc.id}/export?format=json`);
  assert.ok(exported.body.needs_review.length > 0);
  const csv = await fetch(`${base}/documents/${doc.id}/export?format=csv`, { headers });
  assert.match(await csv.text(), /ocr_status,agreement,ocr_confidence,ocr_candidates/);
  assert.equal(aiCalls, 0);
});

test('scanned PDF page evidence uses original page coordinates and digital PDFs keep their behavior', async () => {
  const pdf = await PDFDocument.create();
  const picture = await pdf.embedPng(image()); const page = pdf.addPage([1000, 380]);
  page.drawImage(picture, { x: 0, y: 0, width: 1000, height: 380 });
  const scan = await upload(Buffer.from(await pdf.save()), 'scan.pdf', 'application/pdf');
  assert.equal(scan.status, 200); assert.equal(scan.body.documents[0].ocr.pages[0].page, 1);
  assert.ok(scan.body.documents[0].needs_review.every(item => item.page === 1));
  const digital = await upload(makePdf([['TAX INVOICE', 'Invoice number: DIGITAL-123', 'Seller name: Demo Co', 'Total: INR 500', 'A readable digital page with enough embedded text to avoid OCR rendering.']]), 'digital.pdf', 'application/pdf');
  assert.equal(digital.status, 200); assert.equal(digital.body.documents[0].ocr, undefined);
  assert.equal(digital.body.documents[0].fields.find(f => f.key === 'total_amount').value, 'INR 500');
  assert.equal(aiCalls, 0);
});

test('deep mode falls back to two local engines when cloud OCR is unavailable, including legacy upload', async () => {
  setGeminiClient(null);
  const form = new FormData(); form.append('files', new Blob([image()], { type: 'image/png' }), 'deep-local.png');
  const deep = await request('/extract', { method: 'POST', body: form, headers: { 'x-processing-mode': 'deep' } });
  assert.equal(deep.status, 200);
  assert.equal(deep.body.documents[0].fallbackUsed, true);
  assert.ok(deep.body.documents[0].ocr.pages[0].engines.every(e => e.status === 'ok'));
  assert.ok(deep.body.documents[0].fields.some(f => f.candidates?.some(c => c.engine === 'paddle')));
  const legacy = new FormData(); legacy.append('pdf', new Blob([image()], { type: 'image/png' }), 'legacy-ocr.png');
  const response = await request('/upload', { method: 'POST', body: legacy, headers: { 'x-processing-mode': 'deep' } });
  assert.equal(response.status, 200); assert.ok(response.body.graph.nodes.length);
  assert.ok(response.body.ocr); assert.ok(Array.isArray(response.body.needs_review));
});
