import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { makePng } from './helpers/files.js';
import { ocrConfig, ocrConfigHash } from '../lib/ocr/config.js';
import { shutdownOfflineOcr } from '../lib/offlineOcr.js';

process.env.MONGO_URI = '';
process.env.VERCEL = '1';
process.env.DOXENTRA_ANALYSIS_PIPELINE = 'gemini';
// Existing production settings must not keep the old mandatory review gate on.
process.env.OCR_CROSSCHECK_ENABLED = '1';
delete process.env.OCR_STRICT_REVIEW_ENABLED;
process.env.OCR_ENGINES = 'missing-secondary-engine';
const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const { saveGraph, getDocument, deleteGraph } = await import('../lib/db.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const headers = { 'x-guest-id': 'ocr_default_workspace_123456789', 'x-processing-mode': 'deep' };
const text = 'TAX INVOICE\nInvoice number: OCR-2026-42\nSeller name: Demo Traders\nTotal: INR 500';
const extraction = { docType: 'invoice', title: 'Demo invoice', language: 'en', summary: 'Invoice for INR 500.', entities: [], fields: [
  { key: 'invoice_number', value: 'OCR-2026-42', confidence: 0.99, page: 1, sourceQuote: 'Invoice number: OCR-2026-42' },
  { key: 'seller_name', value: 'Demo Traders', confidence: 0.99, page: 1, sourceQuote: 'Seller name: Demo Traders' },
  { key: 'total_amount', value: 'INR 500', confidence: 0.99, page: 1, sourceQuote: 'Total: INR 500' },
] };
const cloud = () => setGeminiClient({ models: { async generateContent(req) {
  return { text: JSON.stringify(req.config.responseJsonSchema.properties.visibleFields ? { text, visibleFields: [] } : extraction) };
} } });
const request = async (path, init = {}) => {
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  return { status: res.status, body: await res.json() };
};
const upload = async (bytes, name = 'default.png', mimeType = 'image/png', extraHeaders = {}) => {
  const form = new FormData(); form.append('files', new Blob([bytes], { type: mimeType }), name);
  return request('/extract', { method: 'POST', body: form, headers: extraHeaders });
};
const image = () => {
  const canvas = createCanvas(1100, 400); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1100, 400); ctx.fillStyle = '#000'; ctx.font = '38px Arial';
  text.split('\n').forEach((line, i) => ctx.fillText(line, 30, 65 + i * 85));
  return canvas.toBuffer('image/png');
};
const readable = doc => {
  assert.equal(doc.success, true);
  assert.equal(doc.fields.find(f => f.key === 'invoice_number').value, 'OCR-2026-42');
  assert.equal(doc.fields.find(f => f.key === 'total_amount').normalizedValue, 500);
  assert.ok(doc.overallConfidence > 0);
  assert.ok(doc.fields.find(f => f.key === 'invoice_number').confidence > 0.4);
  assert.equal(doc.ocr, undefined);
  assert.ok(!doc.fields.some(f => f.status === 'needs_review'));
  assert.ok(!doc.issues.some(i => i.rule === 'ocr.needs_review'));
};
test.after(async () => { setGeminiClient(null); server.close(); await shutdownOfflineOcr(); });

test('strict consensus is opt-in and changes the extraction cache key', () => {
  assert.equal(ocrConfig({ OCR_CROSSCHECK_ENABLED: '1' }).strictReview, false);
  assert.equal(ocrConfig({ OCR_STRICT_REVIEW_ENABLED: '1' }).strictReview, true);
  assert.notEqual(ocrConfigHash(ocrConfig({})), ocrConfigHash(ocrConfig({ OCR_STRICT_REVIEW_ENABLED: '1' })));
});

test('successful image OCR survives unavailable secondary engines without a review gate', async () => {
  cloud();
  const res = await upload(makePng());
  assert.equal(res.status, 200);
  readable(res.body.documents[0]);
  assert.equal(res.body.documents[0].fallbackUsed, false);
});

test('scanned PDF OCR preserves fields without requiring local consensus', async () => {
  cloud();
  const pdf = await PDFDocument.create(); const picture = await pdf.embedPng(image());
  pdf.addPage([1100, 400]).drawImage(picture, { x: 0, y: 0, width: 1100, height: 400 });
  const res = await upload(Buffer.from(await pdf.save()), 'scan.pdf', 'application/pdf');
  assert.equal(res.status, 200); readable(res.body.documents[0]);
  assert.equal(res.body.documents[0].ocrUsed, true);
});

test('privacy OCR uses a single local reader, retains fields and never calls cloud AI', async () => {
  let calls = 0;
  setGeminiClient({ models: { async generateContent() { calls++; throw new Error('Cloud forbidden'); } } });
  const res = await upload(image(), 'private.png', 'image/png', { 'x-processing-mode': 'privacy' });
  assert.equal(res.status, 200); readable(res.body.documents[0]);
  assert.equal(res.body.documents[0].processingMode, 'privacy'); assert.equal(calls, 0);
});

test('cloud OCR failure falls back locally without blanking the readable fields', async () => {
  setGeminiClient(null);
  const res = await upload(image(), 'fallback.png');
  assert.equal(res.status, 200); readable(res.body.documents[0]);
  assert.equal(res.body.documents[0].fallbackUsed, true);
  assert.match(res.body.documents[0].warning, /Local OCR read/);
});

test('a saved result can re-run its original through the job flow with owner isolation', async () => {
  cloud();
  const original = (await upload(makePng(3, 3), 'retry.png')).body.documents[0];
  // Model a result created by the previous version, including its review history.
  const stored = await getDocument(original.id, { guestId: headers['x-guest-id'] });
  const { _id, ...snapshot } = stored;
  const failed = await saveGraph({ ...snapshot, extractionVersion: 16,
    extraction: { ...stored.extraction, fields: stored.extraction.fields.map(f => ({ ...f, value: null, status: 'needs_review' })) } });
  await deleteGraph(original.id, { guestId: headers['x-guest-id'] });
  const retry = await request(`/documents/${failed._id}/reprocess`, { method: 'POST' });
  assert.equal(retry.status, 202);
  const denied = await request(`/documents/${failed._id}/reprocess`, { method: 'POST', headers: { 'x-guest-id': 'unrelated_ocr_workspace_12345' } });
  assert.equal(denied.status, 404);
  const { job } = retry.body;
  const processed = await request(`/jobs/${job.id}/items/${job.items[0].id}/process`, { method: 'POST' });
  assert.equal(processed.body.job.status, 'done');
  const reread = await request(`/documents/${processed.body.job.items[0].documentId}`);
  readable(reread.body);
  assert.ok((await getDocument(failed._id, { guestId: headers['x-guest-id'] })).extraction.fields.some(f => f.status === 'needs_review'));
});
