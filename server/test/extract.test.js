import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJson, setGeminiClient } from '../lib/ai.js';
import { EXTRACTION_SCHEMA, extractDocument, fallbackExtract, normalizeExtraction } from '../lib/extract.js';
import { DOCUMENT_TYPES, DOC_TYPE_IDS, FIELD_TYPES } from '../lib/schemas.js';
import { fakeGemini } from './helpers/fakeGemini.js';

const invoice = JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url)));
const soon = () => Date.now() + 30_000;

test('schemas: every type has well-formed fields and the required types exist', () => {
  for (const id of ['invoice', 'certificate', 'marksheet', 'application_form', 'report', 'identity_document', 'institutional_record', 'other']) {
    assert.ok(DOC_TYPE_IDS.includes(id), id);
  }
  for (const t of DOCUMENT_TYPES) {
    const keys = t.fields.map(f => f.key);
    assert.equal(new Set(keys).size, keys.length, `${t.id}: unique keys`);
    for (const f of t.fields) {
      assert.ok(FIELD_TYPES.includes(f.type), `${t.id}.${f.key} type`);
      assert.ok(f.label && f.description, `${t.id}.${f.key} label/description`);
      if (f.type === 'enum') assert.ok(f.options?.length, `${t.id}.${f.key} options`);
    }
  }
  assert.deepEqual(EXTRACTION_SCHEMA.properties.docType.enum, DOC_TYPE_IDS);
});

test('parseJson repairs fences, trailing commas and truncated answers', () => {
  assert.deepEqual(parseJson('```json\n{"a": 1,}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Here you go: {"a": [1, 2]} hope it helps'), { a: [1, 2] });
  assert.deepEqual(parseJson('{"a": {"b": "cut off'), { a: { b: 'cut off' } });
  assert.deepEqual(parseJson('{"a": [1, 2,'), { a: [1, 2] });
  assert.throws(() => parseJson('no json here'), SyntaxError);
});

test('normalizeExtraction fills every predefined field and cleans the answer', () => {
  const x = normalizeExtraction(invoice, { pageCount: 1 });
  assert.equal(x.docType, 'invoice');
  assert.equal(x.docTypeConfidence, 0.97);
  const byKey = Object.fromEntries(x.fields.map(f => [f.key, f]));
  // Every predefined invoice field is present, in schema order, then extras.
  const invoiceKeys = DOCUMENT_TYPES.find(t => t.id === 'invoice').fields.map(f => f.key);
  assert.deepEqual(x.fields.slice(0, invoiceKeys.length).map(f => f.key), invoiceKeys);
  assert.equal(byKey.invoice_date.normalizedValue, '2024-03-12');
  assert.equal(byKey.total_amount.normalizedValue, 1180);
  assert.equal(byKey.currency.normalizedValue, 'INR');
  assert.equal(byKey.total_amount.page, 1);
  assert.equal(byKey.total_amount.sourceQuote, 'Total: Rs. 1,180.00');
  assert.equal(byKey.total_amount.required, true);
  // Absent fields: null value, zero confidence, no quote.
  assert.deepEqual([byKey.due_date.value, byKey.due_date.confidence, byKey.due_date.sourceQuote, byKey.due_date.page], [null, 0, null, null]);
  assert.equal(byKey.buyer_gstin.value, null, 'field the model skipped is still listed');
  // Extra field with a messy key is kept and marked.
  assert.equal(byKey.vehicle_no.extra, true);
  assert.equal(byKey.vehicle_no.value, 'MH 12 AB 0000');
  // Entities: types upper-cased, unknown -> OTHER, duplicates removed, page clamped.
  assert.equal(x.entities.filter(e => e.type === 'ORG').length, 2);
  const other = x.entities.find(e => e.type === 'OTHER');
  assert.equal(other.value, 'Net 15');
  assert.equal(other.page, 1, 'page clamped to the page count');
  // Tables are rectangular.
  assert.deepEqual(x.tables[0].rows[1], ['Pen set', '5', '100.00', '']);
});

test('normalizeExtraction never fails on odd but usable answers', () => {
  const x = normalizeExtraction({ docType: 'spaceship', confidence: 2, fields: [{ key: 'title', value: 'Hello', confidence: 87 }], summary: '' });
  assert.equal(x.docType, 'other');
  assert.equal(x.fields.find(f => f.key === 'title').modelConfidence, 0.87, '0-100 scale converted');
  assert.ok(x.summary.length > 0, 'summary is never empty');
  const quote = normalizeExtraction({ docType: 'other', fields: [{ key: 'title', value: 'x', sourceQuote: 'q'.repeat(300) }] }).fields[0].sourceQuote;
  assert.ok(quote.length <= 120);
  assert.throws(() => normalizeExtraction({ hello: 'world' }), e => e.code === 'BAD_AI_OUTPUT');
});

test('extractDocument sends page-tagged text for digital PDFs and the file for scans', async () => {
  const fake = fakeGemini([{ json: invoice }, { json: invoice }]);
  setGeminiClient(fake);
  try {
    const r = await extractDocument({ mode: 'text', text: '=== PAGE 1 ===\nInvoice', pageCount: 1 }, { deadline: soon() });
    assert.equal(r.docType, 'invoice');
    assert.ok(r.model);
    const req = fake.calls[0];
    assert.equal(req.config.temperature, 0);
    assert.equal(req.config.responseMimeType, 'application/json');
    assert.ok(req.config.responseJsonSchema.properties.fields);
    assert.ok(!req.contents[0].parts.some(p => p.inlineData), 'no file for digital PDFs');
    assert.match(req.contents[0].parts.at(-1).text, /=== PAGE 1 ===/);

    await extractDocument({ mode: 'file', file: { data: Buffer.from('img'), mimeType: 'image/png' }, pageCount: 1 }, { deadline: soon() });
    const parts = fake.calls[1].contents[0].parts;
    assert.equal(parts[1].inlineData.mimeType, 'image/png');
    assert.match(parts[0].text, /ocrText/);
  } finally {
    setGeminiClient(null);
  }
});

test('extractDocument retries a malformed answer once, then gives up gracefully', async () => {
  const fake = fakeGemini([{ text: 'not json at all' }, { json: invoice }]);
  setGeminiClient(fake);
  try {
    const r = await extractDocument({ mode: 'text', text: 'x', pageCount: 1 }, { deadline: soon() });
    assert.equal(r.docType, 'invoice');
    assert.equal(fake.calls.length, 2);

    fake.push({ text: '{"nonsense": true}' }, { text: 'still nothing' }, { json: invoice });
    await assert.rejects(extractDocument({ mode: 'text', text: 'x', pageCount: 1 }, { deadline: soon() }), e => e.code === 'BAD_AI_OUTPUT');
    assert.equal(fake.calls.length, 4, 'stops after one retry');
  } finally {
    setGeminiClient(null);
  }
});

test('extractDocument falls back to the next model with backoff on 429/503', async () => {
  const fake = fakeGemini([{ error: { status: 429, message: 'RESOURCE_EXHAUSTED' } }, { json: invoice }]);
  setGeminiClient(fake);
  try {
    const started = Date.now();
    const r = await extractDocument({ mode: 'text', text: 'x', pageCount: 1 }, { deadline: soon() });
    assert.equal(r.docType, 'invoice');
    assert.notEqual(fake.calls[0].model, fake.calls[1].model, 'switched model');
    assert.ok(Date.now() - started >= 450, 'waited before retrying');

    // The rate-limited model is now tried last, so the next call goes straight to the backup.
    fake.push({ json: invoice });
    await extractDocument({ mode: 'text', text: 'x', pageCount: 1 }, { deadline: soon() });
    assert.equal(fake.calls[2].model, fake.calls[1].model, 'skips the model that just returned 429');

    // A non-retryable error is not retried.
    fake.push({ error: { status: 403, message: 'PERMISSION_DENIED' } });
    await assert.rejects(extractDocument({ mode: 'text', text: 'x', pageCount: 1 }, { deadline: soon() }), e => e.status === 403);
  } finally {
    setGeminiClient(null);
  }
});

test('extractDocument stops when the deadline is too close', async () => {
  const fake = fakeGemini([{ json: invoice }]);
  setGeminiClient(fake);
  try {
    await assert.rejects(extractDocument({ mode: 'text', text: 'x', pageCount: 1 }, { deadline: Date.now() + 1000 }));
    assert.equal(fake.calls.length, 0);
  } finally {
    setGeminiClient(null);
  }
});

test('fallbackExtract finds labelled values and regex entities without the AI', () => {
  const x = fallbackExtract([
    'TAX INVOICE\nInvoice No: INV-77\nDate: 05/01/2024\nGSTIN: 27AAACE1234F1Z6\nBill To: Sample Retail Co\nSubtotal: Rs. 1,000.00\nGrand Total: Rs. 1,180.00\nEmail: accounts@example.com',
  ]);
  assert.equal(x.docType, 'invoice');
  assert.ok(x.docTypeConfidence <= 0.6);
  const byKey = Object.fromEntries(x.fields.map(f => [f.key, f]));
  assert.equal(byKey.invoice_number.value, 'INV-77');
  assert.equal(byKey.invoice_date.normalizedValue, '2024-01-05');
  assert.equal(byKey.total_amount.normalizedValue, 1180);
  assert.equal(byKey.seller_gstin.normalizedValue, '27AAACE1234F1Z6');
  assert.equal(byKey.total_amount.page, 1);
  assert.ok(byKey.total_amount.sourceQuote.includes('1,180.00'));
  assert.ok(x.entities.some(e => e.type === 'EMAIL' && e.value === 'accounts@example.com'));
  assert.ok(x.entities.some(e => e.type === 'ID' && e.value === '27AAACE1234F1Z6'));
  assert.match(x.summary, /rule-based/i);
  assert.equal(x.model, 'rule-based');
});

test('cleanBox keeps usable [ymin, xmin, ymax, xmax] boxes on a 0-1000 scale', async () => {
  const { cleanBox } = await import('../lib/extract.js');
  assert.deepEqual(cleanBox([117, 201, 128, 328]), [117, 201, 128, 328]);
  assert.deepEqual(cleanBox([0.117, 0.201, 0.128, 0.328]), [117, 201, 128, 328], '0-1 scale is converted');
  assert.deepEqual(cleanBox([128, 328, 117, 201]), [117, 201, 128, 328], 'swapped corners are fixed');
  assert.deepEqual(cleanBox([-5, 10, 30, 1200]), [0, 10, 30, 1000], 'clamped to the page');
  assert.equal(cleanBox([10, 10, 11, 200]), null, 'too thin');
  assert.equal(cleanBox([0, 0, 1000, 1000]), null, 'the whole page is not a location');
  assert.equal(cleanBox([1, 2, 3]), null);
  assert.equal(cleanBox(null), null);
  assert.equal(cleanBox(['a', 1, 2, 3]), null);
});

test('boxes are kept for found values only', () => {
  const x = normalizeExtraction({
    docType: 'invoice', docTypeConfidence: 0.9, title: 'T', language: 'en', summary: 'S',
    fields: [
      { key: 'invoice_number', label: 'Invoice number', value: 'INV-1', confidence: 0.9, page: 1, sourceQuote: 'Invoice No: INV-1', box: [100, 200, 120, 300] },
      { key: 'due_date', label: 'Due date', value: null, confidence: 0, box: [100, 200, 120, 300] },
    ],
    entities: [],
  });
  assert.deepEqual(x.fields.find(f => f.key === 'invoice_number').box, [100, 200, 120, 300]);
  assert.equal(x.fields.find(f => f.key === 'due_date').box, undefined);
});
