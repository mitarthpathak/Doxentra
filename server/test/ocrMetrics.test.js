import test from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, measureFields, summarizeStages } from '../../scripts/lib/ocrMetrics.mjs';

test('CER/WER count substitutions, insertions, deletions and withheld fields', () => {
  assert.equal(editDistance([... 'kitten'], [... 'sitting']), 3);
  const truth = { fields: { name: 'Asha Verma', number: '1234' } };
  const scored = measureFields({ fields: [
    { key: 'name', type: 'string', value: 'Asha Varma' },
    { key: 'number', type: 'id', value: null, status: 'needs_review' },
  ] }, truth);
  assert.equal(scored.correct, 0); assert.equal(scored.emitted, 1); assert.equal(scored.pending, 1);
  assert.equal(scored.characterEdits, 5); assert.equal(scored.wordEdits, 2);
  assert.equal(scored.cer, 5 / 14); assert.equal(scored.wer, 2 / 3);
  const failed = measureFields(null, truth);
  assert.equal(failed.cer, 1); assert.equal(failed.wer, 1); assert.equal(failed.total, 2);
});

test('accuracy accepts annotated alternatives and equivalent numbers, but rejects digit changes and fuzzy names', () => {
  const truth = { fields: { title: ['Notice', 'Annual Notice'], amount: 'INR 1,000', id: '12345678901', name: 'Asha Verma' } };
  const score = measureFields({ fields: [
    { key: 'title', type: 'string', value: 'Annual Notice' },
    { key: 'amount', type: 'amount', value: '1000.00' },
    { key: 'id', type: 'id', value: '12345678902' },
    { key: 'name', type: 'string', value: 'Asha Varma' },
  ] }, truth);
  assert.equal(score.correct, 2); assert.equal(score.fieldAccuracy, 0.5);
  assert.equal(score.fields[0].characterEdits, 0);
});

test('stage totals use a micro average and include failed samples in the denominator', () => {
  const rows = [
    { stage: 'baseline', ...measureFields({ fields: [{ key: 'name', type: 'string', value: 'Asha' }] }, { fields: { name: 'Asha' } }) },
    { stage: 'baseline', error: 'OCR_TIMEOUT', ...measureFields(null, { fields: { a: '123', b: '456' } }) },
  ];
  const summary = summarizeStages(rows, ['baseline']).baseline;
  assert.equal(summary.fieldAccuracy, 1 / 3); assert.equal(summary.coverage, 1 / 3);
  assert.equal(summary.emittedAccuracy, 1); assert.equal(summary.failures, 1);
  assert.equal(summary.cer, 6 / 10);
});
