import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraction } from '../lib/extract.js';
import { calibrateClassification, guessSubtype, keywordDistribution } from '../lib/classify.js';
import { DOCUMENT_TYPES, TAXONOMY } from '../lib/schemas.js';
import { validateExtraction } from '../lib/validate.js';

const invoiceFields = [
  { key: 'invoice_number', value: 'INV-1' }, { key: 'invoice_date', value: '12/03/2024' }, { key: 'seller_name', value: 'Example Traders' },
  { key: 'seller_gstin', value: '27AAACE1234F1Z6' }, { key: 'buyer_name', value: 'Sample Retail Co' }, { key: 'subtotal', value: '1000' },
  { key: 'total_amount', value: '1180' },
];

test('taxonomy: every type has a category, and subtypes have keywords', () => {
  for (const t of DOCUMENT_TYPES) {
    assert.ok(TAXONOMY[t.id], t.id);
    assert.ok(t.category, `${t.id} category`);
    for (const s of t.subtypes) assert.ok(s.id && s.label, `${t.id}.${s.id}`);
  }
});

test('keywords: whole words for Latin, as written for Hindi', () => {
  assert.equal(keywordDistribution('nothing relevant here'), null);
  assert.equal(keywordDistribution('a transaction'), null, '"sac" is not matched inside a word');
  assert.deepEqual(Object.keys(keywordDistribution('TAX INVOICE  GSTIN 27AAACE1234F1Z6')), ['invoice']);
  assert.ok(keywordDistribution('सूचना / NOTICE').institutional_record === 1);
});

test('confident model + agreeing keywords + all required fields: a high, consistent confidence', () => {
  const x = calibrateClassification(normalizeExtraction({ docType: 'invoice', docTypeConfidence: 1, fields: invoiceFields,
    typeCandidates: [{ docType: 'invoice', confidence: 1 }] }), { textByPage: ['TAX INVOICE GSTIN CGST SGST Grand Total'] });
  assert.equal(x.docTypeConfidence, 1);
  assert.equal(x.typeCandidates[0].docType, 'invoice');
  assert.equal(x.typeCandidates[0].confidence, x.docTypeConfidence, 'badge and first candidate agree');
  assert.equal(x.docCategory, 'Financial');
  assert.equal(x.docSubtype, 'tax_invoice');
  assert.equal(x.classification.subtypeFrom, 'keywords');
});

test('missing required fields and disagreeing keywords lower the confidence', () => {
  const x = calibrateClassification(normalizeExtraction({ docType: 'invoice', docTypeConfidence: 1, fields: [{ key: 'invoice_number', value: 'INV-1' }] }),
    { textByPage: ['Certificate of Completion. This is to certify that'] });
  // 0.8 × 1 + 0.2 × 0 = 0.8; coverage 1/7 → × (0.6 + 0.4/7)
  assert.equal(x.docTypeConfidence, Math.round(0.8 * (0.6 + 0.4 / 7) * 100) / 100);
  assert.equal(x.classification.requiredCoverage, 0.14);
  assert.deepEqual(x.typeCandidates.map(c => c.docType), ['invoice', 'certificate']);
});

test('model candidates: normalised, top 3, a close runner-up is reported', () => {
  const x = calibrateClassification(normalizeExtraction({ docType: 'certificate', docTypeConfidence: 0.55, docSubtype: 'merit',
    typeCandidates: [{ docType: 'certificate', confidence: 0.55 }, { docType: 'marksheet', confidence: 0.4 }, { docType: 'report', confidence: 0.3 }, { docType: 'other', confidence: 0.2 }],
    fields: [{ key: 'certificate_title', value: 'Merit' }, { key: 'recipient_name', value: 'Asha' }, { key: 'issuing_organization', value: 'School' }, { key: 'issue_date', value: '01/01/2024' }] }));
  assert.equal(x.typeCandidates.length, 3);
  const total = x.typeCandidates.reduce((a, c) => a + c.confidence, 0);
  assert.ok(total <= 1.001, `candidates sum to ${total}`);
  assert.equal(x.docSubtype, 'merit');
  assert.equal(x.classification.subtypeFrom, 'model');
  const issues = validateExtraction(x);
  const amb = issues.find(i => i.rule === 'type.ambiguous');
  assert.match(amb.message, /could also be a marksheet \/ report card \(\d+%\)/);
});

test('subtypes: invalid model subtypes are dropped; keywords pick one', () => {
  const x = normalizeExtraction({ docType: 'identity_document', docSubtype: 'spaceship', fields: [] });
  assert.equal(x.docSubtype, null);
  assert.equal(guessSubtype('identity_document', 'INCOME TAX DEPARTMENT Permanent Account Number').id, 'pan_card');
  assert.equal(guessSubtype('other', 'anything'), null);
});
