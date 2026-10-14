import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSnippet, matchesFilters, searchDocuments, tokenMatch, tokenize } from '../lib/search.js';

const doc = (id, docType, fields, extra = {}) => ({
  _id: id,
  filename: `${id}.pdf`,
  createdAt: extra.createdAt || new Date('2024-05-01T10:00:00Z'),
  extraction: {
    docType, docTypeLabel: docType, title: extra.title || id, summary: extra.summary || '', overallConfidence: extra.overall ?? 0.8,
    fields: fields.map(([key, label, value, confidence = 0.9, page = 1]) => ({ key, label, value, confidence, page, sourceQuote: `${label}: ${value}` })),
    entities: extra.entities || [],
    rawTextByPage: extra.text || [],
  },
});

const docs = [
  doc('inv1', 'invoice', [['invoice_number', 'Invoice number', 'INV-2024-0042'], ['seller_name', 'Seller', 'Example Traders Pvt Ltd'], ['total_amount', 'Total amount', 'Rs. 1,18,000.00', 0.95]],
    { summary: 'Tax invoice from Example Traders to Sample Retail Co.', entities: [{ type: 'ORG', value: 'Sample Retail Co', page: 1, confidence: 0.85 }] }),
  doc('cert1', 'certificate', [['recipient_name', 'Recipient', 'Rohan Mehta', 0.4], ['issuing_organization', 'Issued by', 'Example Institute of Technology']],
    { createdAt: new Date('2024-08-10T10:00:00Z'), summary: 'Certificate of completion for a web development course.' }),
  doc('notice1', 'institutional_record', [['title_or_subject', 'Subject', 'वार्षिक परीक्षा कार्यक्रम / Annual examination schedule']],
    { text: ['सूचना\nसभी छात्रों को सूचित किया जाता है कि वार्षिक परीक्षा 15 मार्च से प्रारंभ होगी।\nAll students are informed that annual examinations begin on 15 March.'], overall: 0.6 }),
];

test('tokenize lower-cases, keeps Devanagari and joins digit groups', () => {
  assert.deepEqual(tokenize('Rs. 1,18,000 कुल राशि'), ['rs', '118000', 'कुल', 'राशि']);
  assert.deepEqual(tokenize('१५ मार्च'), ['15', 'मार्च']);
});

test('tokenMatch: exact, prefix and fuzzy', () => {
  assert.equal(tokenMatch('example', 'example'), 1);
  assert.equal(tokenMatch('exam', 'examination'), 0.7);
  assert.equal(tokenMatch('certficate', 'certificate'), 0.5);
  assert.equal(tokenMatch('cat', 'car'), 0, 'short words need exact or prefix');
});

test('field values rank above page text and carry label, page and confidence', () => {
  const hits = searchDocuments(docs, { q: 'example traders' });
  assert.equal(hits[0].documentId, 'inv1');
  assert.equal(hits[0].kind, 'field');
  assert.equal(hits[0].label, 'Seller');
  assert.equal(hits[0].value, 'Example Traders Pvt Ltd');
  assert.equal(hits[0].page, 1);
  assert.equal(hits[0].confidence, 0.9);
  assert.ok(hits.filter(h => h.documentId === 'inv1').length <= 3);
});

test('case-insensitive, prefix and fuzzy queries match', () => {
  assert.equal(searchDocuments(docs, { q: 'ROHAN' })[0].documentId, 'cert1');
  assert.equal(searchDocuments(docs, { q: 'instit' })[0].documentId, 'cert1');
  assert.equal(searchDocuments(docs, { q: 'Mehtaa' })[0].value, 'Rohan Mehta');
  assert.equal(searchDocuments(docs, { q: '118000' })[0].fieldKey, 'total_amount');
  assert.equal(searchDocuments(docs, { q: 'nothing like this' }).length, 0);
});

test('Hindi and English queries reach the bilingual notice', () => {
  const hi = searchDocuments(docs, { q: 'परीक्षा' });
  assert.equal(hi[0].documentId, 'notice1');
  assert.ok(hi.some(h => h.kind === 'text' && h.page === 1));
  assert.equal(searchDocuments(docs, { q: 'annual examinations' })[0].documentId, 'notice1');
});

test('snippets are short and highlight the matching words', () => {
  const hit = searchDocuments(docs, { q: 'परीक्षा' }).find(h => h.kind === 'text');
  for (const [a, b] of hit.highlights) assert.match(hit.snippet.slice(a, b), /परीक्षा/);
  const long = makeSnippet(`${'filler words '.repeat(30)}the needle is here ${'more filler '.repeat(30)}`, ['needle']);
  assert.ok(long.snippet.startsWith('…') && long.snippet.endsWith('…'));
  assert.ok(long.snippet.length < 200);
  const [s, e] = long.highlights[0];
  assert.equal(long.snippet.slice(s, e), 'needle');
});

test('filters: type, minimum confidence and date range', () => {
  assert.ok(searchDocuments(docs, { q: 'example', type: 'certificate' }).every(h => h.docType === 'certificate'));
  // The recipient field has confidence 0.4 and drops out at 0.5.
  assert.equal(searchDocuments(docs, { q: 'rohan', minConfidence: 0.5 }).length, 0);
  assert.equal(searchDocuments(docs, { q: 'example', from: '2024-08-01' }).every(h => h.documentId === 'cert1'), true);
  assert.equal(searchDocuments(docs, { q: 'example', to: '2024-05-01' }).every(h => h.documentId === 'inv1'), true);
  assert.ok(matchesFilters(docs[0], { to: '2024-05-01' }), 'the "to" day is inclusive');
});

test('an empty query lists the documents passing the filters, newest first', () => {
  const hits = searchDocuments(docs, { q: '', minConfidence: 0.7 });
  assert.deepEqual(hits.map(h => h.documentId), ['cert1', 'inv1']);
  assert.equal(hits[0].kind, 'document');
});
