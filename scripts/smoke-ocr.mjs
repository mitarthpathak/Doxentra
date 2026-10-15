import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

// Uses only generated, fictional documents. Pass a deployed URL to verify the
// actual serverless runtime as well as the default localhost API.
const base = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const { createCanvas } = createRequire(new URL('../server/package.json', import.meta.url))('@napi-rs/canvas');
const guestId = `ocr_smoke_${crypto.randomBytes(16).toString('hex')}`;
const invoiceNumber = `SMOKE-${Date.now()}`;
const lines = ['TAX INVOICE', `Invoice number: ${invoiceNumber}`, 'Invoice date: 15/10/2026',
  'Seller name: Demo Traders', 'Buyer name: Sample Customer', 'Subtotal: INR 500', 'Total: INR 500'];
const canvas = createCanvas(1200, 700); const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1200, 700);
ctx.fillStyle = '#000'; ctx.font = '42px Arial';
lines.forEach((line, i) => ctx.fillText(line, 35, 65 + i * 90));
const image = canvas.toBuffer('image/png');
const request = async (path, init = {}, mode = 'deep') => {
  const res = await fetch(`${base}/api${path}`, { ...init,
    headers: { 'x-guest-id': guestId, 'x-processing-mode': mode, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  const body = await res.json();
  assert.ok(res.ok, JSON.stringify(body));
  return body;
};
const verify = doc => {
  assert.equal(doc.success, true, JSON.stringify(doc));
  assert.equal(doc.fields.find(f => f.key === 'invoice_number')?.value, invoiceNumber);
  assert.equal(doc.fields.find(f => f.key === 'total_amount')?.normalizedValue, 500);
  assert.ok(doc.overallConfidence > 0);
  assert.ok(!doc.fields.some(f => f.status === 'needs_review'));
  assert.ok(!doc.issues.some(i => i.rule === 'ocr.needs_review'));
  return { id: doc.id, confidence: doc.overallConfidence, fields: doc.fields.filter(f => f.value != null).length,
    fallbackUsed: doc.fallbackUsed, warning: doc.warning, engines: doc.ocr?.pages };
};
console.log(JSON.stringify(await request('/health?ocr=1')));
for (const mode of ['deep', 'privacy']) {
  const started = Date.now();
  const form = new FormData(); form.append('files', new Blob([image], { type: 'image/png' }), `ocr-smoke-${mode}.png`);
  const doc = (await request('/extract', { method: 'POST', body: form }, mode)).documents[0];
  console.log(JSON.stringify({ mode, elapsedMs: Date.now() - started, ...verify(doc) }));
  if (mode === 'deep') {
    const { job } = await request(`/documents/${doc.id}/reprocess`, { method: 'POST' });
    const completed = await request(`/jobs/${job.id}/items/${job.items[0].id}/process`, { method: 'POST' });
    assert.equal(completed.job.status, 'done');
    console.log(JSON.stringify({ rerun: verify(await request(`/documents/${completed.job.items[0].documentId}`)) }));
  }
}
// A real scanned PDF exercises PDF rendering inside the production function.
const scan = await readFile(new URL('../samples/f-student-id-scanned.pdf', import.meta.url));
const form = new FormData(); form.append('files', new Blob([scan], { type: 'application/pdf' }), 'ocr-smoke-scan.pdf');
const doc = (await request('/extract', { method: 'POST', body: form })).documents[0];
assert.equal(doc.success, true, JSON.stringify(doc));
assert.equal(doc.ocrUsed, true);
assert.ok(doc.fields.some(f => f.value != null));
assert.ok(!doc.fields.some(f => f.status === 'needs_review'));
console.log(JSON.stringify({ scan: { id: doc.id, confidence: doc.overallConfidence, fields: doc.fields.filter(f => f.value != null).length } }));
