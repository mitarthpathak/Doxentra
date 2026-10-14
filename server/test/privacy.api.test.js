import test from 'node:test';
import assert from 'node:assert/strict';
import { makePdf, makePng } from './helpers/files.js';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
process.env.MONGO_URI = '';
process.env.VERCEL = '1';
const { default: app } = await import('../index.js');
const { setGeminiClient, filePart, generateStructured } = await import('../lib/ai.js');
const { withPrivacyMode } = await import('../lib/privacy.js');
const { getDocument } = await import('../lib/db.js');
const { storageRequest } = await import('../lib/supabase.js');
const { getObject } = await import('../lib/storage.js');
const { shutdownOfflineOcr } = await import('../lib/offlineOcr.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const guestId = 'privacy_workspace_1234567890';
const headers = { 'x-guest-id': guestId, 'x-processing-mode': 'privacy' };
let aiCalls = 0;
test.before(() => setGeminiClient({ models: { async generateContent() { aiCalls++; throw new Error('Unexpected AI call'); } } }));
test.after(async () => { setGeminiClient(null); server.close(); await shutdownOfflineOcr(); });
const request = async (path, init = {}) => {
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  return { status: res.status, body: await res.json() };
};
const upload = async (bytes, name, type) => {
  const form = new FormData(); form.append('files', new Blob([bytes], { type }), name);
  return request('/extract', { method: 'POST', body: form });
};

test('offline roadmap image supports extraction, source text, questions, maps, search and exports', async () => {
  const canvas = createCanvas(1200, 420);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, 1200, 420);
  context.fillStyle = '#000'; context.font = '36px Arial';
  ['Cloud + Security', 'MONTH 1: Linux + Networking', 'Linux CLI + bash; curl, dig, ss, tcpdump, nmap', 'MONTH 2: Cloud fundamentals']
    .forEach((line, i) => context.fillText(line, 30, 65 + i * 85));
  const response = await upload(canvas.toBuffer('image/png'), 'roadmap.png', 'image/png');
  assert.equal(response.status, 200);
  const doc = response.body.documents[0];
  assert.equal(doc.processingMode, 'privacy');
  assert.match(doc.fields.find(f => f.key === 'title').value, /Cloud.*Security/);
  assert.ok(doc.fields.some(f => /month_?1/.test(f.key) && /Linux/.test(f.value)));
  assert.ok(doc.overallConfidence > 0);
  assert.ok(doc.docTypeConfidence < 1);
  assert.match(doc.textByPage[0], /tcpdump/);
  assert.ok(!doc.summary.includes('AI unavailable'));
  const json = { 'content-type': 'application/json' };
  const answer = await request('/ask', { method: 'POST', headers: json, body: JSON.stringify({ documentId: doc.id, question: 'What Linux networking tools are listed?' }) });
  assert.equal(answer.body.mode, 'extractive');
  assert.equal(answer.body.answerable, true);
  assert.match(answer.body.notice, /locally without cloud AI/);
  assert.ok(answer.body.citations.some(c => c.verified));
  const map = await request(`/documents/${doc.id}/concept-map`, { method: 'POST' });
  assert.equal(map.status, 200); assert.ok(map.body.graph.nodes.length);
  assert.match(map.body.warning, /local keyword map/);
  const search = await request('/search?q=tcpdump');
  assert.ok(search.body.results.some(r => r.id === doc.id || r.documentId === doc.id));
  const exported = await request(`/documents/${doc.id}/export?format=json`);
  assert.equal(exported.status, 200);
  const csv = await fetch(`${base}/documents/${doc.id}/export?format=csv`, { headers });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /Linux/);
  const translation = await request(`/documents/${doc.id}/translate`, { method: 'POST', headers: json, body: JSON.stringify({ to: 'hi' }) });
  assert.equal(translation.status, 422); assert.match(translation.body.error, /High-Privacy Mode/);
  assert.equal(aiCalls, 0);
});

test('privacy corrections mask newly entered personal data and their audit trail', async () => {
  const response = await upload(makePdf([['Identity document', 'Holder name: Asha Verma', 'ID number: LOCAL-001', 'A readable document containing enough embedded text for local identity parsing.']]), 'review.pdf', 'application/pdf');
  const doc = response.body.documents[0];
  const changed = await request(`/documents/${doc.id}/fields/holder_name`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'correct', value: 'Priya Sharma', note: 'Corrected Priya Sharma, phone 9876543210' }),
  });
  assert.equal(changed.status, 200);
  const stored = await withPrivacyMode(true, () => getDocument(doc.id, { guestId }));
  for (const secret of ['Priya Sharma', '9876543210']) {
    assert.ok(!JSON.stringify(stored).includes(secret));
    assert.ok(!JSON.stringify(changed.body).includes(secret));
  }
});

test('privacy PDFs use local validation, mask persisted PII, and isolate cloud workspace', async () => {
  const result = await upload(makePdf([[
    'Aadhaar Identity Document', 'Document name: Aadhaar', 'ID number: 2345 6789 0123',
    'Holder name: Asha Verma', 'Phone: 9876543210', 'PAN: ABCPE1234F',
    'This digital document contains selectable text for local parsing and checksum verification.',
  ]]), 'identity.pdf', 'application/pdf');
  assert.equal(result.status, 200);
  const doc = result.body.documents[0];
  assert.equal(doc.model, 'rule-based');
  assert.equal(doc.hasFile, false, 'no unmasked original is attached to the result');
  const stored = await withPrivacyMode(true, () => getDocument(doc.id, { guestId }));
  const content = JSON.stringify(stored);
  for (const secret of ['2345 6789 0123', '9876543210', 'ABCPE1234F', 'Asha Verma']) assert.ok(!content.includes(secret), `masked ${secret}`);
  assert.ok(doc.issues.some(i => i.rule === 'aadhaar.checksum'), 'validate before masking');
  assert.equal((await request(`/documents/${doc.id}`, { headers: { 'x-processing-mode': 'deep' } })).status, 404);
  assert.equal((await request(`/documents/${doc.id}`)).status, 200);
  assert.equal(aiCalls, 0);
});

test('privacy processes scans/images with local OCR and never calls cloud AI', async () => {
  for (const [bytes, name, mime] of [[makePng(), 'scan.png', 'image/png'], [makePdf([[]]), 'scan.pdf', 'application/pdf']]) {
    const result = await upload(bytes, name, mime);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const doc = result.body.documents[0];
    assert.equal(doc.fallbackUsed, true);
    assert.equal(doc.ocrUsed, true);
    assert.equal(doc.textLayer, 'scanned');
    assert.equal(doc.hasFile, false);
    assert.ok(doc.issues.some(i => i.rule === 'text.unreadable'));
    assert.ok(doc.issues.some(i => i.rule === 'extraction.empty'));
  }
  assert.equal(aiCalls, 0);
});

test('privacy combines selectable and scanned pages in a mixed PDF', async () => {
  const pdf = await PDFDocument.create();
  const digital = pdf.addPage([900, 180]);
  digital.drawText('Invoice number: LOCAL-MIX-1. This digital page has selectable text and should remain readable.', { x: 25, y: 110, size: 18 });
  const canvas = createCanvas(900, 180);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 900, 180);
  context.fillStyle = 'black'; context.font = 'bold 52px Arial';
  context.fillText('TOTAL INR 500', 25, 110);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  const scanned = pdf.addPage([900, 180]);
  scanned.drawImage(image, { x: 0, y: 0, width: 900, height: 180 });
  const response = await upload(Buffer.from(await pdf.save()), 'mixed.pdf', 'application/pdf');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const doc = response.body.documents[0];
  assert.equal(doc.fallbackUsed, true);
  assert.equal(doc.ocrUsed, true);
  assert.equal(doc.textLayer, 'mixed');
  assert.equal(doc.pageCount, 2);
  const stored = await withPrivacyMode(true, () => getDocument(doc.id, { guestId }));
  assert.match(stored.extraction.rawTextByPage[0], /LOCAL-MIX-1/);
  assert.match(stored.extraction.rawTextByPage[1], /TOTAL INR 500/);
  assert.equal(aiCalls, 0);
});

test('privacy signed uploads and jobs stay local even when Supabase is configured', async () => {
  process.env.SUPABASE_URL = 'https://cloud-storage.invalid'; process.env.SUPABASE_SECRET_KEY = 'test';
  try {
    const target = await request('/uploads/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'local.pdf', mimeType: 'application/pdf' }) });
    assert.equal(target.body.mode, 'direct'); assert.equal(target.body.uploadUrl, undefined);
    const form = new FormData(); form.append('file', new Blob([makePdf([['Invoice', 'Invoice number: TEST-1', 'Seller name: Example Co', 'Total: INR 500', 'A digital invoice with enough readable text to support local parsing.']])], { type: 'application/pdf' }), 'local.pdf');
    const uploaded = await request('/uploads', { method: 'POST', body: form });
    assert.equal(uploaded.status, 200); assert.equal(uploaded.body.driver, 'memory');
    assert.equal(await withPrivacyMode(false, () => getObject(uploaded.body)), null, 'deep mode cannot read private upload bytes');
    const created = await request('/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ path: uploaded.body.path, filename: 'local.pdf', mimeType: 'application/pdf' }] }) });
    assert.equal(created.status, 202);
    const job = created.body.job;
    const processed = await request(`/jobs/${job.id}/items/${job.items[0].id}/process`, { method: 'POST' });
    assert.equal(processed.body.job.items[0].status, 'done');
    assert.equal(aiCalls, 0);
  } finally { process.env.SUPABASE_URL = ''; process.env.SUPABASE_SECRET_KEY = ''; }
});

test('privacy cloud boundaries fail closed and request contexts are isolated', async () => {
  await withPrivacyMode(true, async () => {
    await assert.rejects(generateStructured({ parts: [], schema: {} }), { code: 'PRIVACY_MODE' });
    await assert.rejects(filePart({ data: Buffer.alloc(30_000_000), mimeType: 'image/png' }), { code: 'PRIVACY_MODE' });
    await assert.rejects(storageRequest('GET', '/bucket'), { code: 'PRIVACY_MODE' });
  });
  assert.equal(aiCalls, 0);
  assert.equal((await request('/documents', { headers: { 'x-processing-mode': 'unknown' } })).status, 400);
});

test('legacy upload also honors privacy masking and local scan OCR', async () => {
  const form = new FormData();
  form.append('pdf', new Blob([makePdf([['Aadhaar card', 'Holder name: Asha Verma', 'ID number: 2345 6789 0124', 'A selectable digital document containing local text for processing without network access.']])], { type: 'application/pdf' }), 'legacy.pdf');
  const response = await request('/upload', { method: 'POST', body: form });
  assert.equal(response.status, 200); assert.ok(response.body.graph.nodes.length);
  assert.ok(!JSON.stringify(response.body).includes('Asha Verma'));
  assert.ok(!JSON.stringify(response.body).includes('2345 6789 0124'));
  const scan = new FormData(); scan.append('pdf', new Blob([makePng()], { type: 'image/png' }), 'legacy.png');
  assert.equal((await request('/upload', { method: 'POST', body: scan })).status, 200);
  assert.equal(aiCalls, 0);
});

test('privacy-only deployment cannot be downgraded by a deep request', async () => {
  process.env.DOXENTRA_PRIVACY_ONLY = '1';
  try {
    const response = await request('/health', { headers: { 'x-processing-mode': 'deep' } });
    assert.equal(response.body.mongodb, 'local-only'); assert.equal(response.body.fileStorage, 'memory');
    await assert.rejects(generateStructured({ parts: [], schema: {} }), { code: 'PRIVACY_MODE' });
  } finally { delete process.env.DOXENTRA_PRIVACY_ONLY; }
});

test('privacy retains deterministic GSTIN and PAN failures after digit masking', async () => {
  const response = await upload(makePdf([['Tax Invoice', 'Invoice number: LOCAL-TAX-1', 'Seller name: Example Co', 'Seller GSTIN: 27AAACE1234F1Z5', 'Seller PAN: AAADE1234F', 'Total: INR 500', 'Invoice date: 01/01/2025', 'A readable invoice with local deterministic validation of tax identifiers.']]), 'tax-AAADE1234F.pdf', 'application/pdf');
  assert.equal(response.status, 200);
  const doc = response.body.documents[0];
  assert.ok(doc.issues.some(i => i.rule === 'gstin.checksum'));
  assert.ok(doc.issues.some(i => i.rule === 'pan.holder_type'));
  assert.ok(!JSON.stringify(response.body).includes('AAADE1234F'));
  assert.ok(!JSON.stringify(response.body).includes('AAACE1234F'));
  assert.equal(aiCalls, 0);
});
