import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './helpers/files.js';
import { fakeGemini } from './helpers/fakeGemini.js';
import { revalidate, reviewDocument, reviewField } from '../lib/review.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const { updateDocument } = await import('../lib/db.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const invoice = JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url)));
const pdf = makePdf([[
  'TAX INVOICE', 'Invoice No: INV-2024-0042', 'Date: 12/03/2024', 'Seller: Example Traders Pvt Ltd', 'GSTIN: 27AAACE1234F1Z6',
  'Bill To: Sample Retail Co', 'Subtotal: Rs. 1,000.00', 'GST 18%: Rs. 180.00', 'Total: Rs. 1,180.00', 'Vehicle No: MH 12 AB 0000',
]]);

async function user() {
  const email = `r${Date.now()}${Math.random()}@example.com`;
  const r = await fetch(base + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret12', phone: '1', age: 20 }),
  });
  return { email, headers: { authorization: `Bearer ${(await r.json()).token}`, 'content-type': 'application/json' } };
}

async function extractAs(headers) {
  const fd = new FormData();
  fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'invoice.pdf');
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    return (await (await fetch(base + '/extract', { method: 'POST', body: fd, headers: { authorization: headers.authorization } })).json()).documents[0];
  } finally {
    setGeminiClient(null);
  }
}

const field = (doc, key) => doc.fields.find(f => f.key === key);
const rules = doc => doc.issues.map(i => i.rule);

test('review: correct, confirm, reset and approve a field, with an append-only audit trail', async () => {
  const alice = await user();
  const doc = await extractAs(alice.headers);
  assert.equal(doc.review.status, 'unreviewed');
  assert.deepEqual(doc.audit, []);
  assert.ok(!rules(doc).includes('invoice.total_mismatch'));
  const patch = (key, body) => fetch(`${base}/documents/${doc.id}/fields/${key}`, { method: 'PATCH', headers: alice.headers, body: JSON.stringify(body) });

  // A wrong correction: the document is validated again and the total no longer adds up.
  let r = await patch('total_amount', { action: 'correct', value: 'Rs. 1,280.00', note: 'typed from the paper copy' });
  assert.equal(r.status, 200);
  let d = await r.json();
  assert.equal(field(d, 'total_amount').value, 'Rs. 1,280.00');
  assert.equal(field(d, 'total_amount').normalizedValue, 1280);
  assert.equal(field(d, 'total_amount').confidence, 1, 'a person checked it');
  assert.equal(field(d, 'total_amount').review.status, 'corrected');
  assert.equal(field(d, 'total_amount').review.original.value, 'Rs. 1,180.00');
  assert.ok(rules(d).includes('invoice.total_mismatch'));
  assert.ok(field(d, 'tax_total').confidence < field(doc, 'tax_total').confidence, 'fields named in the new error lose their validation score');
  assert.ok(d.overallConfidence < doc.overallConfidence);
  assert.equal(d.review.status, 'in_review');
  assert.equal(d.auditEntry.by, alice.email);
  assert.deepEqual([d.auditEntry.action, d.auditEntry.fieldKey, d.auditEntry.from, d.auditEntry.to, d.auditEntry.note],
    ['correct', 'total_amount', 'Rs. 1,180.00', 'Rs. 1,280.00', 'typed from the paper copy']);
  assert.equal(d.auditEntry.issuesAfter.error, d.auditEntry.issuesBefore.error + 1);

  // Reset restores the AI's value and its confidence; the error goes away again.
  d = await (await patch('total_amount', { action: 'reset' })).json();
  assert.equal(field(d, 'total_amount').value, 'Rs. 1,180.00');
  assert.equal(field(d, 'total_amount').confidence, field(doc, 'total_amount').confidence);
  assert.equal(field(d, 'total_amount').review, undefined);
  assert.ok(!rules(d).includes('invoice.total_mismatch'));
  assert.equal(field(d, 'tax_total').confidence, field(doc, 'tax_total').confidence);

  // Confirm, then approve; a later change withdraws the approval.
  d = await (await patch('invoice_number', { action: 'confirm' })).json();
  assert.equal(field(d, 'invoice_number').confidence, 1);
  assert.equal(d.review.reviewed, 1);
  r = await fetch(`${base}/documents/${doc.id}/review`, { method: 'POST', headers: alice.headers, body: JSON.stringify({ action: 'approve' }) });
  d = await r.json();
  assert.equal(d.review.status, 'approved');
  assert.equal(d.review.approvedBy, alice.email);
  d = await (await patch('buyer_name', { action: 'correct', value: 'Sample Retail Company' })).json();
  assert.equal(d.review.status, 'in_review');
  assert.equal(d.auditEntry.approvalWithdrawn, true);
  assert.equal((await (await fetch(`${base}/documents?`, { headers: alice.headers })).json()).documents[0].reviewStatus, 'in_review');

  // The trail, oldest first, also on GET /documents/:id and in the JSON export.
  const audit = (await (await fetch(`${base}/documents/${doc.id}/audit`, { headers: alice.headers })).json()).audit;
  assert.deepEqual(audit.map(a => a.action), ['correct', 'reset', 'confirm', 'approve', 'correct']);
  assert.ok(audit.every(a => a.by === alice.email && !Number.isNaN(Date.parse(a.at))));
  const fresh = await (await fetch(`${base}/documents/${doc.id}`, { headers: alice.headers })).json();
  assert.equal(fresh.auditCount, 5);
  assert.equal(field(fresh, 'buyer_name').value, 'Sample Retail Company');
  const exported = await (await fetch(`${base}/documents/${doc.id}/export?format=json`, { headers: alice.headers })).json();
  assert.equal(exported.audit.length, 5);
  const csv = await (await fetch(`${base}/documents/${doc.id}/export?format=csv`, { headers: alice.headers })).text();
  assert.match(csv, /review_status,Review status,in_review,2\/\d+ fields reviewed/);
  assert.match(csv, new RegExp(`buyer_name,.*corrected by ${alice.email.replace(/\./g, '\\.')}`));
});

test('review: bad requests, other owners and concurrent changes', async () => {
  const alice = await user();
  const bob = await user();
  const doc = await extractAs(alice.headers);
  // The same file was reviewed by someone else in the test above: this copy is the AI's own.
  assert.equal(doc.cached, true);
  assert.equal(doc.review.status, 'unreviewed');
  assert.equal(field(doc, 'buyer_name').value, 'Sample Retail Co');
  assert.ok(doc.fields.every(f => !f.review));
  assert.deepEqual(doc.audit, []);
  const patch = (key, body, headers = alice.headers) =>
    fetch(`${base}/documents/${doc.id}/fields/${key}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await patch('total_amount', { action: 'confirm' }, bob.headers)).status, 404);
  assert.equal((await fetch(`${base}/documents/${doc.id}/audit`, { headers: bob.headers })).status, 404);
  assert.equal((await patch('total_amount', { action: 'delete' })).status, 400);
  assert.equal((await patch('nope', { action: 'confirm' })).status, 404);
  assert.equal((await patch('total_amount', { action: 'correct', value: 5 })).status, 400);
  assert.equal((await patch('total_amount', { action: 'correct', value: 'Rs. 1,180.00' })).status, 400, 'unchanged');
  assert.equal((await patch('due_date', { action: 'confirm' })).status, 400, 'nothing to confirm');
  assert.equal((await patch('total_amount', { action: 'reset' })).status, 400, 'not reviewed');
  const review = body => fetch(`${base}/documents/${doc.id}/review`, { method: 'POST', headers: alice.headers, body: JSON.stringify(body) });
  assert.equal((await review({ action: 'reopen' })).status, 400);
  // Clearing a required value is allowed and reported as missing.
  const d = await (await patch('invoice_number', { action: 'correct', value: null })).json();
  assert.equal(field(d, 'invoice_number').value, null);
  assert.ok(d.issues.some(i => i.rule === 'required.missing' && i.fieldKeys.includes('invoice_number')));
  // A save based on an out-of-date trail is refused.
  const owner = { _id: (await (await fetch(`${base}/auth/me`, { headers: alice.headers })).json()).user.id, email: alice.email };
  assert.equal(await updateDocument(doc.id, owner, { 'extraction.title': 'x' }, { audit: { action: 'confirm' }, auditLength: 0 }), null);
});

test('revalidate keeps the OCR and unverified caps of AI-scored fields', () => {
  const base = { key: 'subtotal', label: 'Subtotal', type: 'amount', required: true, value: '100', normalizedValue: 100 };
  const x = {
    docType: 'invoice', fields: [
      { ...base, confidenceDetail: { model: 1, verification: 1, validation: 1, capped: ['ocr'] } },
      { ...base, key: 'total_amount', label: 'Total', value: '100', confidenceDetail: { model: 1, verification: 0, validation: 1, capped: ['unverified'] } },
    ], entities: [], tables: [], issues: [],
  };
  const r = revalidate(x);
  assert.equal(r.fields[0].confidence, 0.9);
  assert.equal(r.fields[1].confidence, 0.4);
  const { extraction } = reviewField(r, 'subtotal', { action: 'confirm' }, { by: 'a@example.com' });
  assert.equal(extraction.fields[0].confidence, 1);
  assert.throws(() => reviewDocument(extraction, { action: 'publish' }, { by: 'a' }), /approve, reopen/);
});
