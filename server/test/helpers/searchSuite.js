// Search API checks shared by the in-memory and the MongoDB test runs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './files.js';
import { fakeGemini } from './fakeGemini.js';

const invoice = JSON.parse(readFileSync(new URL('../fixtures/gemini/invoice.json', import.meta.url)));
const notice = {
  docType: 'institutional_record', docTypeConfidence: 0.9, title: 'Annual examination notice', language: 'hi+en',
  summary: 'Bilingual notice announcing the annual examination schedule.',
  fields: [
    { key: 'title_or_subject', label: 'Subject', value: 'Annual examination schedule', confidence: 0.9, page: 1, sourceQuote: 'Subject: Annual examination schedule' },
    { key: 'issuing_institution', label: 'Issuing institution', value: 'Model Public School', confidence: 0.9, page: 1, sourceQuote: 'Model Public School' },
    { key: 'date', label: 'Date', value: '02/01/2024', confidence: 0.9, page: 1, sourceQuote: 'Date: 02/01/2024' },
  ],
  entities: [{ type: 'ORG', value: 'Model Public School', page: 1, sourceQuote: 'Model Public School' }],
};

export async function runSearchSuite(t, { base, setGeminiClient }) {
  const test = (name, fn) => t.test(name, fn);
  const signup = await fetch(base + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `s${Date.now()}${Math.random()}@example.com`, password: 'secret12', phone: '1', age: 20 }),
  });
  const auth = { authorization: `Bearer ${(await signup.json()).token}` };

  const upload = async (bytes, name, answer) => {
    setGeminiClient(fakeGemini([{ json: answer }]));
    try {
      const fd = new FormData();
      fd.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
      const r = await fetch(base + '/extract', { method: 'POST', body: fd, headers: auth });
      return (await r.json()).documents[0];
    } finally {
      setGeminiClient(null);
    }
  };
  const inv = await upload(makePdf([['Invoice No: INV-2024-0042', 'Seller: Example Traders Pvt Ltd', 'Total: Rs. 1,180.00', `Ref ${Math.random()}`]]), 'invoice.pdf', invoice);
  const note = await upload(makePdf([['Model Public School', 'Subject: Annual examination schedule', 'Date: 02/01/2024', 'All students are informed that annual examinations begin on 15 March.', `Ref ${Math.random()}`]]), 'notice.pdf', notice);
  assert.ok(inv.id && note.id);

  const search = async params => {
    const r = await fetch(`${base}/search?${new URLSearchParams(params)}`, { headers: auth });
    return { status: r.status, body: await r.json() };
  };

  await test('search requires sign-in and validates filters', async () => {
    assert.equal((await fetch(`${base}/search?q=x`)).status, 401);
    assert.equal((await search({ q: 'x', type: 'spaceship' })).status, 400);
    assert.equal((await search({ q: 'x', minConfidence: '5' })).status, 400);
    assert.equal((await search({ q: 'x', from: 'yesterday-ish' })).status, 400);
  });

  await test('search finds field values with label, page, confidence and highlights', async () => {
    const { status, body } = await search({ q: 'example traders' });
    assert.equal(status, 200);
    const hit = body.results[0];
    assert.equal(hit.documentId, inv.id);
    assert.equal(hit.kind, 'field');
    assert.equal(hit.label, 'Seller');
    assert.equal(hit.page, 1);
    assert.equal(typeof hit.confidence, 'number');
    assert.ok(hit.highlights.length >= 2);
    assert.equal(hit.docType, 'invoice');
  });

  await test('search covers page text, prefixes and misspellings', async () => {
    let { body } = await search({ q: 'students informed' });
    assert.equal(body.results[0].documentId, note.id);
    assert.ok(body.results.some(h => h.kind === 'text'));
    ({ body } = await search({ q: 'examin' }));
    assert.equal(body.results[0].documentId, note.id, 'prefix');
    ({ body } = await search({ q: 'Tradres' }));
    assert.equal(body.results[0].documentId, inv.id, 'misspelt');
  });

  await test('search filters by type, confidence and date', async () => {
    let { body } = await search({ q: 'school', type: 'invoice' });
    assert.equal(body.count, 0);
    ({ body } = await search({ q: 'school', type: 'institutional_record' }));
    assert.ok(body.count > 0);
    ({ body } = await search({ q: 'school', minConfidence: '1' }));
    assert.equal(body.count, 0);
    ({ body } = await search({ q: 'school', to: '2000-01-01' }));
    assert.equal(body.count, 0);
    ({ body } = await search({ q: '', type: 'invoice' }));
    assert.ok(body.results.every(h => h.docType === 'invoice') && body.count >= 1);
  });

  await test('documents list, export and delete work on this backend', async () => {
    const list = await (await fetch(base + '/documents', { headers: auth })).json();
    assert.ok(list.documents.some(d => d.id === inv.id));
    const full = await (await fetch(`${base}/documents/${inv.id}`, { headers: auth })).json();
    assert.ok(full.fields.length && full.issues);
    assert.equal((await fetch(`${base}/documents/${inv.id}/export?format=csv`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/documents/${note.id}`, { method: 'DELETE', headers: auth })).status, 200);
    const { body } = await search({ q: 'school' });
    assert.ok(!body.results.some(h => h.documentId === note.id));
  });
}
