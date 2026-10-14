import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf, makePng } from './helpers/files.js';
import { fakeGemini } from './helpers/fakeGemini.js';

// Run without external services: no database, Gemini replaced by a fake.
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
const invoiceLines = [
  'TAX INVOICE', 'Invoice No: INV-2024-0042', 'Date: 12/03/2024', 'Seller: Example Traders Pvt Ltd',
  'GSTIN: 27AAACE1234F1Z6', 'Bill To: Sample Retail Co', 'Subtotal: Rs. 1,000.00', 'GST 18%: Rs. 180.00', 'Total: Rs. 1,180.00',
];
const invoicePdf = makePdf([invoiceLines]);

async function extract(files, token) {
  const fd = new FormData();
  for (const [bytes, name, type] of files) fd.append('files', new Blob([bytes], { type }), name);
  const r = await fetch(base + '/extract', { method: 'POST', body: fd, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.json() };
}

test('digital PDF: one structured call over the page-tagged text, then cached', async () => {
  const fake = fakeGemini([{ json: invoice }]);
  setGeminiClient(fake);
  try {
    const { status, body } = await extract([[invoicePdf, 'invoice.pdf', 'application/pdf']]);
    assert.equal(status, 200);
    const doc = body.documents[0];
    assert.equal(doc.success, true);
    assert.equal(doc.docType, 'invoice');
    assert.equal(doc.ocrUsed, false);
    assert.equal(doc.textLayer, 'digital');
    assert.equal(doc.pageCount, 1);
    assert.ok(doc.summary);
    assert.equal(doc.fields.find(f => f.key === 'total_amount').normalizedValue, 1180);
    assert.equal(fake.calls.length, 1, 'single Gemini call for classify + extract + summarise');
    const parts = fake.calls[0].contents[0].parts;
    assert.ok(!parts.some(p => p.inlineData), 'digital PDF sends text only');
    assert.match(parts.at(-1).text, /=== PAGE 1 ===[\s\S]*INV-2024-0042/);

    // Same file again: answered from the cache without calling Gemini.
    const again = await extract([[invoicePdf, 'copy.pdf', 'application/pdf']]);
    assert.equal(again.body.documents[0].cached, true);
    assert.equal(again.body.documents[0].filename, 'copy.pdf');
    assert.equal(fake.calls.length, 1);
  } finally {
    setGeminiClient(null);
  }
});

test('images and scanned PDFs go through the OCR path', async () => {
  const fake = fakeGemini([
    { json: { ...invoice, ocrText: [{ page: 1, text: 'TAX INVOICE Total: Rs. 1,180.00' }] } },
    { json: { ...invoice, docType: 'certificate', docTypeConfidence: 0.9, fields: [] } },
  ]);
  setGeminiClient(fake);
  try {
    const img = await extract([[makePng(3, 3), 'photo.png', 'image/png']]);
    assert.equal(img.status, 200);
    assert.equal(img.body.documents[0].ocrUsed, true);
    assert.equal(fake.calls[0].contents[0].parts[1].inlineData.mimeType, 'image/png');

    const scan = await extract([[makePdf([[], []]), 'scan.pdf', 'application/pdf']]);
    const doc = scan.body.documents[0];
    assert.equal(doc.ocrUsed, true);
    assert.equal(doc.textLayer, 'scanned');
    assert.equal(doc.pageCount, 2);
    assert.equal(doc.docType, 'certificate');
    assert.ok(doc.fields.length > 0, 'predefined certificate fields listed even when none found');
    assert.equal(fake.calls[1].contents[0].parts[1].inlineData.mimeType, 'application/pdf');
  } finally {
    setGeminiClient(null);
  }
});

test('multi-file request: every file is handled independently', async () => {
  const fake = fakeGemini([{ json: invoice }]);
  setGeminiClient(fake);
  try {
    const other = makePdf([['A completely different invoice document with enough text to count as digital.']]);
    const { status, body } = await extract([
      [other, 'a.pdf', 'application/pdf'],
      [Buffer.from('not an image'), 'fake.jpg', 'image/jpeg'],
    ]);
    assert.equal(status, 200);
    assert.equal(body.documents.length, 2);
    assert.equal(body.documents[0].success, true);
    assert.equal(body.documents[1].success, false);
    assert.match(body.documents[1].error, /not a valid image/);
  } finally {
    setGeminiClient(null);
  }
});

test('without the AI: digital PDFs get a rule-based extraction, images a clear error', async () => {
  const pdf = makePdf([['TAX INVOICE', 'Invoice No: INV-9', 'Date: 01/02/2024', 'Grand Total: Rs. 590.00']]);
  const { status, body } = await extract([[pdf, 'basic.pdf', 'application/pdf']]);
  assert.equal(status, 200);
  const doc = body.documents[0];
  assert.equal(doc.fallbackUsed, true);
  assert.match(doc.warning, /not configured/);
  assert.equal(doc.docType, 'invoice');
  assert.equal(doc.fields.find(f => f.key === 'invoice_number').value, 'INV-9');

  // Fallback results are not cached: a later upload with the AI gets a full extraction.
  const fake = fakeGemini([{ json: invoice }]);
  setGeminiClient(fake);
  try {
    const again = await extract([[pdf, 'basic.pdf', 'application/pdf']]);
    assert.equal(again.body.documents[0].fallbackUsed, false);
    assert.equal(fake.calls.length, 1);
  } finally {
    setGeminiClient(null);
  }

  const img = await extract([[makePng(), 'photo.png', 'image/png']]);
  assert.equal(img.status, 422);
  assert.match(img.body.error, /image needs OCR and the AI service is not configured/);
});

test('extract validates the request', async () => {
  let r = await fetch(base + '/extract', { method: 'POST', body: new FormData() });
  assert.equal(r.status, 400);
  const fd = new FormData();
  for (let i = 0; i < 6; i++) fd.append('files', new Blob([makePng()], { type: 'image/png' }), `p${i}.png`);
  r = await fetch(base + '/extract', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Too many files/);
  r = (await extract([[Buffer.from('hello'), 'notes.txt', 'text/plain']]));
  assert.equal(r.status, 400);
});

test('extraction-only documents do not appear as concept maps in history', async () => {
  const email = `x${Date.now()}@example.com`;
  const signup = await fetch(base + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret12', phone: '1', age: 20 }),
  });
  const { token } = await signup.json();
  const fake = fakeGemini([{ json: invoice }]);
  setGeminiClient(fake);
  try {
    const r = await extract([[makePdf([['Unique document for the history check, with enough characters.']]), 'h.pdf', 'application/pdf']], token);
    assert.equal(r.status, 200);
  } finally {
    setGeminiClient(null);
  }
  const hist = await (await fetch(base + '/graphs', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(hist.graphs.length, 0);
});

test('extracted fields carry blended confidence, bands and an overall score', async () => {
  // The fixture's quotes match the PDF text, except one invented value.
  const answer = structuredClone(invoice);
  answer.fields.find(f => f.key === 'buyer_name').value = 'Imaginary Buyer Ltd';
  answer.fields.find(f => f.key === 'buyer_name').sourceQuote = 'Bill To: Imaginary Buyer Ltd';
  const fake = fakeGemini([{ json: answer }]);
  setGeminiClient(fake);
  try {
    const pdf = makePdf([[...invoiceLines, 'Ref: confidence test']]);
    const { body } = await extract([[pdf, 'conf.pdf', 'application/pdf']]);
    const doc = body.documents[0];
    const f = Object.fromEntries(doc.fields.map(x => [x.key, x]));
    assert.equal(f.invoice_number.confidenceBand, 'high');
    assert.ok(f.invoice_number.confidence > f.invoice_number.modelConfidence, 'verified quote boosts');
    assert.equal(f.invoice_number.confidenceDetail.quoteFound, true);
    assert.equal(f.buyer_name.confidenceBand, 'low', 'hallucinated value penalised');
    assert.equal(f.due_date.confidence, 0);
    assert.ok(doc.overallConfidence > 0 && doc.overallConfidence <= 1);
    assert.ok(Array.isArray(doc.issues));
    assert.ok(doc.entities.every(e => typeof e.confidence === 'number'));
  } finally {
    setGeminiClient(null);
  }
});

test('planted inconsistencies come back as issues', async () => {
  const answer = structuredClone(invoice);
  answer.fields.find(f => f.key === 'total_amount').value = 'Rs. 1,250.00';
  answer.fields.find(f => f.key === 'seller_gstin').value = null;
  answer.tables = [];
  const fake = fakeGemini([{ json: answer }]);
  setGeminiClient(fake);
  try {
    const pdf = makePdf([[...invoiceLines.filter(l => !l.startsWith('GSTIN')), 'Total due: Rs. 1,250.00']]);
    const { body } = await extract([[pdf, 'bad.pdf', 'application/pdf']]);
    const { issues } = body.documents[0];
    assert.ok(issues.some(i => i.severity === 'error' && i.type === 'missing' && i.fieldKeys.includes('seller_gstin')));
    assert.ok(issues.some(i => i.severity === 'error' && i.type === 'inconsistent' && i.fieldKeys.includes('total_amount')));
  } finally {
    setGeminiClient(null);
  }
});
