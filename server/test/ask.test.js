import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunkText, extractiveAnswer, passagesOf, quoteSupported, rankPassages, selectSources, shapeAnswer } from '../lib/ask.js';
import { makePdf } from './helpers/files.js';
import { fakeGemini } from './helpers/fakeGemini.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';

const invoiceDoc = {
  _id: 'inv1', filename: 'invoice.pdf',
  extraction: {
    title: 'Tax invoice ET/0147', docTypeLabel: 'Invoice', summary: 'Tax invoice from Example Traders to Sample Retail Co for ₹18,880.', pageCount: 1,
    fields: [
      { key: 'invoice_number', label: 'Invoice number', value: 'ET/2024-25/0147', page: 1, sourceQuote: 'Invoice No: ET/2024-25/0147', confidence: 0.98 },
      { key: 'total_amount', label: 'Total amount', value: '₹ 18,880.00', normalizedValue: 18880, page: 1, sourceQuote: 'Total ₹ 18,880.00', confidence: 0.97 },
      { key: 'due_date', label: 'Due date', value: null },
    ],
    issues: [{ severity: 'warning', type: 'format', fieldKeys: ['seller_gstin'], message: 'Seller GSTIN "27XYZ" is not a valid GSTIN format.' }],
    rawTextByPage: ['TAX INVOICE\nExample Traders Pvt Ltd\nInvoice No: ET/2024-25/0147\nSubtotal ₹ 16,000.00\nTotal ₹ 18,880.00\nPayment Terms: Net 30'],
  },
};
const noticeDoc = {
  _id: 'not1', filename: 'notice.pdf',
  extraction: {
    title: 'परीक्षा सूचना', docTypeLabel: 'Letter / notice / record', summary: 'Notice about the annual examinations starting 15 March 2024.', pageCount: 1,
    fields: [{ key: 'deadline_date', label: 'Deadline', value: '10/03/2024', page: 1, sourceQuote: 'अंतिम तिथि: 10/03/2024', confidence: 0.9 }],
    issues: [],
    rawTextByPage: ['वार्षिक परीक्षा 15 मार्च 2024 से आरंभ होंगी।\nअंतिम तिथि: 10/03/2024\nAnnual examinations begin on 15 March 2024.'],
  },
};

test('chunkText splits long text with overlap and keeps short text whole', () => {
  assert.deepEqual(chunkText('short'), ['short']);
  assert.deepEqual(chunkText(''), []);
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i} with some words`).join('\n');
  const chunks = chunkText(long, 200, 50);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.length <= 200));
  // Overlap: the end of one chunk reappears at the start of the next.
  assert.ok(chunks[1].includes(chunks[0].split('\n').at(-1)));
});

test('passages cover profile, fields, issues and page text', () => {
  const kinds = passagesOf(invoiceDoc).map(p => p.kind);
  assert.deepEqual([...new Set(kinds)], ['profile', 'field', 'issue', 'text']);
  assert.equal(kinds.filter(k => k === 'field').length, 2, 'missing values are not passages');
});

test('ranking finds the right field, in English and Hindi, ignoring question words', () => {
  const passages = [...passagesOf(invoiceDoc), ...passagesOf(noticeDoc)];
  const total = rankPassages('What is the total amount of the invoice?', passages);
  assert.equal(total[0].fieldKey, 'total_amount');
  const hindi = rankPassages('अंतिम तिथि क्या है?', passages);
  assert.equal(hindi[0].documentId, 'not1');
  assert.deepEqual(rankPassages('what is the', passages), [], 'only stop words: nothing to rank');
  const typo = rankPassages('invoce numbr', passages);
  assert.equal(typo[0].fieldKey, 'invoice_number');
});

test('sources include document profiles so general questions work', () => {
  const { sources } = selectSources('summarise', [invoiceDoc]);
  assert.ok(sources.some(s => s.kind === 'profile'));
  assert.ok(sources.some(s => s.kind === 'field'), 'single document without matches: fields are given');
  assert.equal(sources[0].id, 'S1');
});

test('answers are renumbered by first use, unknown sources dropped, quotes verified', () => {
  const sources = selectSources('total amount invoice number', [invoiceDoc]).sources;
  const total = sources.find(s => s.fieldKey === 'total_amount');
  const number = sources.find(s => s.fieldKey === 'invoice_number');
  const shaped = shapeAnswer({
    answer: `Invoice ${'ET/2024-25/0147'} [${number.id}] totals ₹18,880 [${total.id}, S99] .`,
    answerable: true,
    citations: [
      { source: total.id, quote: 'Total amount: ₹ 18,880.00' },
      { source: number.id, quote: 'Invoice number: ET/2099-99/9999' }, // not what the source says
      { source: 'S99', quote: 'made up' },
    ],
  }, sources);
  assert.equal(shaped.answer, 'Invoice ET/2024-25/0147 [1] totals ₹18,880 [2].');
  assert.deepEqual(shaped.citations.map(c => c.fieldKey), ['invoice_number', 'total_amount']);
  assert.equal(shaped.citations[1].verified, true);
  assert.equal(shaped.citations[0].verified, false, 'a quote that is not in the source is flagged');
  assert.equal(shaped.citations[0].page, 1);
  assert.equal(shaped.citations[0].documentId, 'inv1');
  assert.equal(shapeAnswer({ answer: 'Not in the documents.', answerable: true, citations: [] }, sources).answerable, false, 'no citations: not answerable');
});

test('quoteSupported tolerates spacing and case but not changed numbers', () => {
  assert.ok(quoteSupported('total  ₹ 18,880.00', 'Subtotal ₹ 16,000.00\nTotal ₹ 18,880.00'));
  assert.ok(!quoteSupported('Total ₹ 19,880.00', 'Total ₹ 18,880.00'));
  assert.ok(!quoteSupported('', 'anything'));
});

test('extractive answer quotes the best passages with citations', () => {
  const { sources } = selectSources('payment terms', [invoiceDoc]);
  const a = extractiveAnswer('payment terms', sources);
  assert.equal(a.answerable, true);
  assert.match(a.answer, /Net 30/);
  assert.equal(a.citations[0].page, 1);
  assert.equal(extractiveAnswer('zebra crossing', selectSources('zebra crossing', [invoiceDoc]).sources).answerable, false);
});

// ─── API ─────────────────────────────────────────────────────────────
let server, base, setGeminiClient;
// Register lifecycle hooks synchronously at file scope. A top-level await after
// unit tests have been registered can attach cleanup to an already-running test.
test.before(async () => {
  const { default: app } = await import('../index.js');
  ({ setGeminiClient } = await import('../lib/ai.js'));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server?.close());
const invoice = JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url)));
const guest = () => ({ 'x-guest-id': `ask${Date.now()}${Math.random().toString(36).slice(2)}xxxxxxxxxxxx`.slice(0, 40) });

async function extractAs(headers) {
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    const fd = new FormData();
    fd.append('files', new Blob([makePdf([['TAX INVOICE', 'Invoice No: INV-2024-0042', 'Seller: Example Traders Pvt Ltd', 'Total: Rs. 1,180.00', `Ref ${Math.random()}`]])], { type: 'application/pdf' }), 'invoice.pdf');
    return (await (await fetch(base + '/extract', { method: 'POST', body: fd, headers })).json()).documents[0];
  } finally {
    setGeminiClient(null);
  }
}
const ask = (headers, body) => fetch(base + '/ask', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('POST /api/ask answers with verified citations to document and page', async () => {
  const g = guest();
  const doc = await extractAs(g);
  const fake = fakeGemini([req => {
    // The sources are numbered; cite the one holding the total.
    const sources = req.contents[0].parts[1].text;
    const id = sources.match(/\[(S\d+)\] \([^)]*extracted field\)\nTotal amount/)[1];
    return { text: JSON.stringify({ answer: `The invoice total is Rs. 1,180.00 [${id}].`, answerable: true, citations: [{ source: id, quote: 'Total amount: Rs. 1,180.00' }], followUps: ['Who is the seller?'] }) };
  }]);
  setGeminiClient(fake);
  try {
    const { status, body } = await ask(g, { question: 'What is the total amount?', history: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 200);
    assert.equal(body.mode, 'ai');
    assert.equal(body.answer, 'The invoice total is Rs. 1,180.00 [1].');
    assert.equal(body.citations[0].documentId, doc.id);
    assert.equal(body.citations[0].fieldKey, 'total_amount');
    assert.equal(body.citations[0].page, 1);
    assert.equal(body.citations[0].verified, true);
    assert.deepEqual(body.followUps, ['Who is the seller?']);
    const prompt = fake.calls[0].contents[0].parts.map(p => p.text).join('\n');
    assert.match(prompt, /CONVERSATION SO FAR:\nUser: hi/);
    assert.match(prompt, /QUESTION: What is the total amount\?/);
  } finally {
    setGeminiClient(null);
  }
});

test('POST /api/ask without the AI quotes the best passages; scope and access are enforced', async () => {
  const g = guest();
  const doc = await extractAs(g);
  const { body } = await ask(g, { question: 'Who is the seller?', documentId: doc.id });
  assert.equal(body.mode, 'extractive');
  assert.match(body.notice, /not configured/);
  assert.equal(body.scope, 'document');
  assert.match(body.citations[0].quote, /Example Traders/);

  assert.equal((await ask(g, { question: '' })).status, 400);
  assert.equal((await ask({}, { question: 'x' })).status, 401);
  assert.equal((await ask(guest(), { question: 'seller', documentId: doc.id })).status, 404, "another workspace's document");
  const empty = await ask(guest(), { question: 'seller?' });
  assert.equal(empty.body.answerable, false);
  assert.equal(empty.body.documentCount, 0);
});
