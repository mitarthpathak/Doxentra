import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HALLUCINATION_CAP, OCR_CAP, confidenceBand, looseText, overallConfidence, quoteInText,
  scoreExtraction, scoreField, textLayerPagesFor, validationScore, valueInQuote,
} from '../lib/confidence.js';

const page1 = 'TAX INVOICE\nInvoice No: INV-2024-0042\nDate: 12/03/2024\nGSTIN: 27ABCDE1234F1Z5\nTotal: Rs. 1,18,000.00';
const digital = { textByPage: [page1, 'Terms and conditions'], ocrUsed: false };
const field = over => ({
  key: 'total_amount', label: 'Total', type: 'amount', required: true,
  value: 'Rs. 1,18,000.00', normalizedValue: 118000, modelConfidence: 0.9,
  page: 1, sourceQuote: 'Total: Rs. 1,18,000.00', ...over,
});

test('bands: high >= 0.80, medium 0.50-0.79, low < 0.50', () => {
  assert.equal(confidenceBand(0.8), 'high');
  assert.equal(confidenceBand(0.79), 'medium');
  assert.equal(confidenceBand(0.5), 'medium');
  assert.equal(confidenceBand(0.49), 'low');
});

test('looseText ignores case, punctuation, digit grouping and Devanagari digits', () => {
  assert.equal(looseText('Total:  Rs. 1,18,000.00'), 'total rs 118000 00');
  assert.equal(looseText('कुल: ₹ १,०००'), 'कुल 1000');
});

test('verified quote on the cited page is boosted above the model confidence', () => {
  const s = scoreField(field(), digital);
  // 0.5*0.9 + 0.3*1 + 0.2*1 = 0.95
  assert.equal(s.confidence, 0.95);
  assert.equal(s.confidenceBand, 'high');
  assert.equal(s.confidenceDetail.quoteFound, true);
  assert.equal(s.confidenceDetail.source, 'text_layer');
});

test('hallucinated quote and value are penalised to low', () => {
  const s = scoreField(field({ value: 'Rs. 2,50,000.00', normalizedValue: 250000, sourceQuote: 'Grand Total: Rs. 2,50,000.00', modelConfidence: 0.99 }), digital);
  assert.equal(s.confidence, HALLUCINATION_CAP);
  assert.equal(s.confidenceBand, 'low');
  assert.deepEqual(s.confidenceDetail.capped, ['unverified']);
});

test('a paraphrased quote loses the verification share but is not capped when the value is in the text', () => {
  const s = scoreField(field({ sourceQuote: 'the invoice total is one lakh eighteen thousand' }), digital);
  // 0.45 + 0 + 0.2
  assert.equal(s.confidence, 0.65);
  assert.equal(s.confidenceBand, 'medium');
});

test('quote found on another page scores a little less than on the cited page', () => {
  const right = scoreField(field(), digital).confidence;
  const wrongPage = scoreField(field({ page: 2 }), digital).confidence;
  assert.ok(wrongPage < right && wrongPage > 0.8);
});

test('failed validation lowers confidence', () => {
  const ok = scoreField(field({ key: 'seller_gstin', type: 'id', format: 'gstin', value: '27ABCDE1234F1Z5', normalizedValue: '27ABCDE1234F1Z5', sourceQuote: 'GSTIN: 27ABCDE1234F1Z5' }), digital);
  const bad = scoreField(field({ key: 'seller_gstin', type: 'id', format: 'gstin', value: '27ABCDE1234F1Z5', normalizedValue: '27ABCDE1234F1Z5', sourceQuote: 'GSTIN: 27ABCDE1234F1Z5' }),
    { ...digital, issues: [{ severity: 'error', type: 'inconsistent', fieldKeys: ['seller_gstin'] }] });
  assert.equal(Math.round((ok.confidence - bad.confidence) * 100) / 100, 0.2);
  assert.equal(validationScore({ type: 'id', format: 'pan', value: 'X', normalizedValue: 'NOTAPAN1' }), 0);
  assert.equal(validationScore({ key: 'a', type: 'string', value: 'x' }, [{ severity: 'warning', type: 'format', fieldKeys: ['a'] }]), 0.5);
  assert.equal(validationScore({ key: 'a', type: 'string', value: 'x' }, [{ severity: 'warning', type: 'low_confidence', fieldKeys: ['a'] }]), 1, 'low_confidence issues do not feed back');
});

test('OCR values are capped at 0.90 even when everything checks out', () => {
  const s = scoreField(field({ modelConfidence: 1 }), { textByPage: [page1], ocrUsed: true, textLayerPages: [false] });
  assert.equal(s.confidence, OCR_CAP);
  assert.equal(s.confidenceDetail.source, 'ocr');
  assert.deepEqual(s.confidenceDetail.capped, ['ocr']);
  // Without any transcription the quote can only be checked against the value.
  const noText = scoreField(field({ modelConfidence: 0.9 }), { textByPage: [], ocrUsed: true });
  assert.equal(noText.confidence, 0.8); // 0.45 + 0.3*0.5 + 0.2
});

test('missing values score 0', () => {
  const s = scoreField(field({ value: null, normalizedValue: null, sourceQuote: null }), digital);
  assert.equal(s.confidence, 0);
  assert.equal(s.confidenceBand, 'low');
});

test('valueInQuote compares amounts, dates and IDs by their normalised form', () => {
  assert.equal(valueInQuote(field({ value: '118000' }), 'Total: Rs. 1,18,000.00'), 1);
  assert.equal(valueInQuote({ type: 'date', value: '12 March 2024', normalizedValue: '2024-03-12' }, 'Date: 12/03/2024'), 1);
  assert.equal(valueInQuote({ type: 'id', value: '27 ABCDE 1234F1Z5', normalizedValue: '27ABCDE1234F1Z5' }, 'GSTIN: 27ABCDE1234F1Z5'), 1);
  assert.equal(valueInQuote({ type: 'string', value: 'Sample Retail' }, 'Bill To: Example Traders'), 0);
  assert.equal(valueInQuote({ type: 'enum', value: '₹', normalizedValue: 'INR' }, 'Total ₹ 18,880.00'), 1, 'symbol-only value');
});

test('quoteInText tolerates small extraction differences but not invented text', () => {
  assert.equal(quoteInText('Invoice No : INV-2024-0042', 1, [page1]), 1);
  assert.ok(quoteInText('Invoice Number: INV-2024-0042 Date 12/03/2024', 1, [page1]) > 0);
  assert.equal(quoteInText('Purchase order PO-7781 approved', 1, [page1]), 0);
});

test('overall confidence is the mean of required fields minus issue penalties', () => {
  const fields = [{ required: true, confidence: 0.9 }, { required: true, confidence: 0.7 }, { required: false, confidence: 0.1 }];
  assert.equal(overallConfidence(fields), 0.8);
  assert.equal(overallConfidence(fields, [{ severity: 'error' }, { severity: 'warning' }, { severity: 'info' }]), 0.73);
  assert.equal(overallConfidence([{ required: false, value: 'x', confidence: 0.6 }]), 0.6, 'falls back to found fields');
  assert.equal(overallConfidence([]), 0);
});

test('scoreExtraction scores fields and entities; textLayerPagesFor marks text vs OCR pages', () => {
  const x = scoreExtraction({
    fields: [field(), field({ key: 'due_date', type: 'date', value: null, normalizedValue: null })],
    entities: [{ type: 'ID', value: '27ABCDE1234F1Z5', page: 1, sourceQuote: 'GSTIN: 27ABCDE1234F1Z5' }, { type: 'ORG', value: 'Imaginary Corp', page: 1, sourceQuote: 'Imaginary Corp' }],
  }, digital);
  assert.equal(x.fields[0].confidenceBand, 'high');
  assert.equal(x.fields[1].confidence, 0);
  assert.ok(x.entities[0].confidence >= 0.8);
  assert.equal(x.entities[1].confidenceBand, 'low');

  assert.deepEqual(textLayerPagesFor(['x'.repeat(50), ''], 2, true), [true, false]);
  assert.deepEqual(textLayerPagesFor(['x'.repeat(50), 'short'], 2, false), [true, true]);
  assert.deepEqual(textLayerPagesFor([], 1, true), [false]);
});
