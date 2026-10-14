import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './helpers/files.js';
import { fakeGemini } from './helpers/fakeGemini.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const invoice = JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url)));
const pdf = makePdf([[
  'TAX INVOICE', 'Invoice No: INV-2024-0042', 'Date: 12/03/2024', 'Seller: Example Traders Pvt Ltd', 'GSTIN: 27AAACE1234F1Z6',
  'Bill To: Sample Retail Co', 'Subtotal: Rs. 1,000.00', 'GST 18%: Rs. 180.00', 'Total: Rs. 1,180.00', 'Vehicle No: MH 12 AB 0000',
]]);

async function user() {
  const r = await fetch(base + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `d${Date.now()}${Math.random()}@example.com`, password: 'secret12', phone: '1', age: 20 }),
  });
  return { authorization: `Bearer ${(await r.json()).token}` };
}

async function extractAs(headers, bytes = pdf, name = 'invoice.pdf') {
  const fd = new FormData();
  fd.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
  return (await (await fetch(base + '/extract', { method: 'POST', body: fd, headers })).json()).documents[0];
}

test('documents require sign-in', async () => {
  for (const path of ['/documents', '/documents/abc', '/documents/abc/export']) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(base + '/documents/abc', { method: 'DELETE' })).status, 401);
});

test('list, get, export and delete a saved extraction', async () => {
  const alice = await user();
  const bob = await user();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  let saved;
  try {
    saved = await extractAs(alice);
  } finally {
    setGeminiClient(null);
  }
  assert.ok(saved.id);

  const list = await (await fetch(base + '/documents', { headers: alice })).json();
  assert.equal(list.documents.length, 1);
  const item = list.documents[0];
  assert.equal(item.docType, 'invoice');
  assert.equal(item.id, saved.id);
  assert.equal(typeof item.overallConfidence, 'number');
  assert.equal(typeof item.issueCounts.total, 'number');
  assert.equal(item.fields, undefined, 'list items are short');

  const full = await (await fetch(`${base}/documents/${saved.id}`, { headers: alice })).json();
  assert.equal(full.fields.find(f => f.key === 'invoice_number').value, 'INV-2024-0042');
  assert.ok(full.issues);
  assert.equal(full.rawTextByPage, undefined, 'page text is not sent to the client');

  // Other users cannot see or delete it.
  assert.equal((await fetch(`${base}/documents/${saved.id}`, { headers: bob })).status, 404);
  assert.equal((await fetch(`${base}/documents/${saved.id}`, { method: 'DELETE', headers: bob })).status, 404);
  assert.equal((await (await fetch(base + '/documents', { headers: bob })).json()).documents.length, 0);

  const json = await fetch(`${base}/documents/${saved.id}/export?format=json`, { headers: alice });
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-disposition'), /attachment; filename="invoice-extraction\.json"/);
  const exported = await json.json();
  assert.equal(exported.docType, 'invoice');
  assert.ok(exported.exportedAt);

  const csv = await fetch(`${base}/documents/${saved.id}/export?format=csv`, { headers: alice });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const text = bytes.subarray(3).toString('utf8');
  assert.ok(text.startsWith('section,key,label,value'));
  assert.match(text, /field,invoice_number,Invoice number,INV-2024-0042,INV-2024-0042,0\.\d+,high,1,Invoice No: INV-2024-0042/);
  assert.match(text, /field,total_amount,Total amount,"Rs\. 1,180\.00",1180,/);
  assert.match(text, /entity,ORG,ORG,Example Traders Pvt Ltd/);
  assert.match(text, /table,table_1_row_1,Line items,Notebook \| 10 \| 50\.00 \| 500\.00/);

  assert.equal((await fetch(`${base}/documents/${saved.id}/export?format=xml`, { headers: alice })).status, 400);

  assert.equal((await fetch(`${base}/documents/${saved.id}`, { method: 'DELETE', headers: alice })).status, 200);
  assert.equal((await fetch(`${base}/documents/${saved.id}`, { headers: alice })).status, 404);
});

test('a concept map can be built from an extracted document and shows up in History', async () => {
  const alice = await user();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  let saved;
  try {
    saved = await extractAs(alice, makePdf([['Photosynthesis converts light energy into chemical energy in chloroplasts using chlorophyll and water.']]), 'notes.pdf');
  } finally {
    setGeminiClient(null);
  }
  // No AI key: falls back to the keyword map, stored on the same record.
  const r = await fetch(`${base}/documents/${saved.id}/concept-map`, { method: 'POST', headers: alice });
  const map = await r.json();
  assert.equal(r.status, 200);
  assert.ok(map.graph.nodes.length > 0);
  assert.equal(map.fallbackUsed, true);
  assert.ok(map.warning);

  const again = await (await fetch(`${base}/documents/${saved.id}/concept-map`, { method: 'POST', headers: alice })).json();
  assert.equal(again.cached, true);

  const hist = await (await fetch(base + '/graphs', { headers: alice })).json();
  assert.equal(hist.graphs.length, 1);
  assert.equal(hist.graphs[0]._id, saved.id);
  assert.equal(hist.graphs[0].fallbackUsed, true);

  const doc = await (await fetch(`${base}/documents/${saved.id}`, { headers: alice })).json();
  assert.equal(doc.hasGraph, true);
  assert.equal(doc.docType, 'invoice', 'extraction kept');

  // Deleting the map from History keeps the extracted document.
  assert.equal((await fetch(`${base}/graphs/${saved.id}`, { method: 'DELETE', headers: alice })).status, 200);
  assert.equal((await (await fetch(base + '/graphs', { headers: alice })).json()).graphs.length, 0);
  const kept = await (await fetch(`${base}/documents/${saved.id}`, { headers: alice })).json();
  assert.equal(kept.hasGraph, false);
});

test('a result the client already has can be exported without signing in', async () => {
  const body = { id: 'x', filename: 'scan.png', docType: 'invoice', docTypeLabel: 'Invoice', summary: 'S', fields: [{ key: 'total_amount', label: 'Total', value: 'Rs. 5', normalizedValue: 5, confidence: 0.9, confidenceBand: 'high', page: 1, sourceQuote: 'Total Rs. 5' }], entities: [], tables: [], issues: [] };
  const csv = await fetch(base + '/documents/export?format=csv', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /field,total_amount,Total,Rs\. 5,5,0\.9,high,1,Total Rs\. 5/);
  const json = await (await fetch(base + '/documents/export?format=json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.equal(json.fields[0].key, 'total_amount');
  const bad = await fetch(base + '/documents/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 400);
});

test('the validation rule catalogue is public', async () => {
  const r = await (await fetch(base + '/validation/rules')).json();
  assert.ok(r.rules.length >= 40);
  const checksum = r.rules.find(x => x.id === 'gstin.checksum');
  assert.equal(checksum.severity, 'warning');
  assert.match(checksum.description, /mod-36/);
});
