import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraction } from '../lib/extract.js';
import { finalizeExtraction } from '../lib/pipeline.js';
import { toDocumentResponse, toDocumentSummary } from '../lib/documentView.js';
import { validateExtraction } from '../lib/validate.js';
const raw = () => normalizeExtraction({ docType: 'institutional_record', docTypeConfidence: 0.9, title: 'Nakal', summary: 'Land record', fields: [
  { key: 'title_or_subject', value: 'Nakal', confidence: 0.9 },
  { key: 'issuing_institution', value: 'Tehsil Garhi', confidence: 0.9 },
] }, { pageCount: 1 });

test('institutional records do not require a date or fabricate one', () => {
  const result = finalizeExtraction(raw(), { textByPage: ['Nakal\nTehsil Garhi'], ocrUsed: true });
  assert.equal(result.fields.find(f => f.key === 'date').required, false);
  assert.equal(result.fields.find(f => f.key === 'date').value, null);
  assert.ok(!result.issues.some(i => i.rule === 'required.missing' && i.fieldKeys.includes('date')));
});

test('old saved records lose only obsolete date requirements and missing errors', () => {
  const extraction = raw();
  extraction.fields.find(f => f.key === 'date').required = true;
  extraction.issues = [{ rule: 'required.missing', severity: 'error', type: 'missing', fieldKeys: ['date'], message: 'Date is missing.' },
    { rule: 'required.missing', severity: 'error', type: 'missing', fieldKeys: ['issuing_institution'], message: 'Issuing institution is missing.' }];
  const saved = { _id: 'saved', extraction, filename: 'nakal.pdf' };
  const response = toDocumentResponse(saved);
  assert.equal(response.fields.find(f => f.key === 'date').required, false);
  assert.equal(response.issueCounts.error, 1);
  assert.equal(response.issues[0].fieldKeys[0], 'issuing_institution');
  assert.equal(toDocumentSummary(saved).issueCounts.error, 1);
  assert.ok(!validateExtraction(extraction).some(i => i.rule === 'required.missing' && i.fieldKeys.includes('date')));
  assert.equal(extraction.fields.find(f => f.key === 'date').required, true, 'read policy does not mutate saved data');
});

test('other document types retain their existing date requirements', () => {
  const invoice = normalizeExtraction({ docType: 'invoice', fields: [] }, { pageCount: 1 });
  assert.ok(validateExtraction(invoice).some(i => i.rule === 'required.missing' && i.fieldKeys.includes('invoice_date')));
});
