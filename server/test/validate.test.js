import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsDiffer, lowConfidenceIssues, validateExtraction } from '../lib/validate.js';
import { normalizeExtraction } from '../lib/extract.js';
import { finalizeExtraction } from '../lib/pipeline.js';
import { certificateDoc, invoiceDoc, marksheetDoc } from './helpers/docs.js';

const now = new Date('2025-01-15T00:00:00Z');
const run = doc => validateExtraction(doc, { now });
const find = (issues, re) => issues.find(i => re.test(i.message));

test('a correct invoice has no issues', () => {
  assert.deepEqual(run(invoiceDoc()), []);
});

test('invoice: total mismatch and missing GSTIN are flagged as errors', () => {
  const issues = run(invoiceDoc({ total: 'Rs. 1,250.00', gstin: null }));
  const total = find(issues, /Total ₹1,250 does not match/);
  assert.equal(total.severity, 'error');
  assert.equal(total.type, 'inconsistent');
  assert.ok(total.fieldKeys.includes('total_amount'));
  const missing = find(issues, /Seller GSTIN is missing/);
  assert.equal(missing.severity, 'error');
  assert.equal(missing.type, 'missing');
  assert.equal(issues[0].severity, 'error', 'errors first');
});

test('invoice: line items, qty × rate, tax split, GST rate and due date', () => {
  let issues = run(invoiceDoc({ rows: [['Notebook', '10', '50.00', '500.00'], ['Pen set', '5', '100.00', '450.00'], ['Total', '', '', '950.00']] }));
  assert.equal(find(issues, /Line items add up to ₹950/).severity, 'error');
  assert.equal(find(issues, /5 × ₹100 = ₹500, but the amount shown is ₹450/).severity, 'warning');
  assert.ok(!find(issues, /Line item 3/), 'total rows are not items');

  issues = run(invoiceDoc({ fields: [{ key: 'sgst', value: 'Rs. 80.00', confidence: 0.9 }] }));
  assert.ok(find(issues, /CGST .* and SGST .* should be equal/));
  assert.ok(find(issues, /does not equal CGST \+ SGST/));

  issues = run(invoiceDoc({ fields: [{ key: 'due_date', value: '01/03/2024', confidence: 0.9 }] }));
  assert.equal(find(issues, /Due date .* is before the invoice date/).severity, 'error');

  const odd = normalizeExtraction({ docType: 'invoice', fields: [
    { key: 'subtotal', value: '1000' }, { key: 'tax_total', value: '150' }, { key: 'total_amount', value: '1150' },
  ] });
  assert.equal(find(run(odd), /not a standard GST rate/).severity, 'info');
});

test('invoice: invalid GSTIN and PAN formats are warnings', () => {
  const issues = run(invoiceDoc({ gstin: '27AAACE1234F1X5', fields: [{ key: 'seller_pan', value: 'ABCD1234F' }] }));
  assert.equal(find(issues, /Seller GSTIN .* not a valid GSTIN/).severity, 'warning');
  assert.equal(find(issues, /Seller PAN .* not a valid PAN/).type, 'format');
  const mismatch = run(invoiceDoc({ fields: [{ key: 'seller_pan', value: 'ZZZZZ9999Z' }] }));
  assert.ok(find(mismatch, /PAN in the GSTIN/));
});

test('marksheet: correct one passes; wrong total, wrong percentage and pass/fail are flagged', () => {
  assert.deepEqual(run(marksheetDoc()), []);
  let issues = run(marksheetDoc({ total: '420', percentage: '84' }));
  assert.equal(find(issues, /Subject marks add up to 412, but the total shown is 420/).severity, 'error');
  assert.ok(!find(issues, /Percentage/), '84% matches the (wrong) total of 420');

  issues = run(marksheetDoc({ percentage: '86.5' }));
  assert.equal(find(issues, /Percentage 86.5% does not match 412 \/ 500 = 82.40%/).severity, 'error');

  issues = run(marksheetDoc({
    total: '312', percentage: '62.4',
    rows: [['English', '100', '85'], ['Hindi', '100', '20'], ['Mathematics', '100', '90'], ['Science', '100', '39'], ['Social Science', '100', '78']],
  }));
  assert.ok(find(issues, /Result is PASS, but 1 subject/));
  issues = run(marksheetDoc({ result: 'FAIL' }));
  assert.ok(find(issues, /Result is FAIL/));
  issues = run(marksheetDoc({ rows: [['English', '100', '105'], ['Hindi', '100', '78'], ['Mathematics', '100', '90'], ['Science', '100', '81'], ['Social Science', '100', '58']] }));
  assert.ok(find(issues, /English: marks obtained \(105\) exceed the maximum/));
});

test('certificate: issue date after expiry is an error; spelling variants are warnings', () => {
  assert.deepEqual(run(certificateDoc()), []);
  const issues = run(certificateDoc({ issue: '20/08/2024', valid: '19/08/2023' }));
  const order = find(issues, /Valid until \(2023-08-19\) is before issue date/);
  assert.equal(order.severity, 'error');
  assert.deepEqual(order.fieldKeys, ['issue_date', 'valid_until']);
  assert.ok(find(issues, /has passed; the document has expired/));

  const names = run(certificateDoc({ entities: [{ type: 'PERSON', value: 'Rohan Mehtaa' }, { type: 'PERSON', value: 'Rohan Mehta' }, { type: 'PERSON', value: 'Dr. S. Iyer' }] }));
  const variant = find(names, /written differently: "Rohan Mehta" and "Rohan Mehtaa"/);
  assert.equal(variant.severity, 'warning');
  assert.deepEqual(variant.fieldKeys, ['recipient_name']);
  assert.equal(names.filter(i => /written differently/.test(i.message)).length, 1);

  // Live Gemini returned the variant with a title: "Mr. Rohan Mehtaa".
  const titled = run(certificateDoc({ entities: [{ type: 'PERSON', value: 'Mr. Rohan Mehtaa' }, { type: 'PERSON', value: 'Dr. Kavita Rao' }] }));
  assert.ok(find(titled, /written differently: "Rohan Mehta" and "Mr\. Rohan Mehtaa"/));
  assert.ok(!find(titled, /Kavita/), 'a title alone does not make a different name');

  // Found in the page text even when the model lists no such entity.
  const fromText = validateExtraction(certificateDoc(), { now, textByPage: ['This is to certify that Rohan Mehta has completed the course.\nVerification: issued to Mr. Rohan Mehtaa.'] });
  assert.equal(find(fromText, /written differently: "Rohan Mehta" and "Rohan Mehtaa"/)?.severity, 'warning');
  const clean = validateExtraction(certificateDoc(), { now, textByPage: ['This is to certify that Mr. Rohan Mehta has completed the course. Signed: Dr. Kavita Rao, Rohan Hall.'] });
  assert.ok(!find(clean, /written differently/), JSON.stringify(clean));
});

test('general: future dates, impossible birth dates, duplicated IDs, unmasked Aadhaar', () => {
  const doc = normalizeExtraction({ docType: 'application_form', docTypeConfidence: 0.9, fields: [
    { key: 'form_title', value: 'Admission Form' }, { key: 'applicant_name', value: 'Neha Rao' },
    { key: 'application_date', value: '10/10/2030' }, { key: 'date_of_birth', value: '01/01/2031' },
    { key: 'application_number', value: 'APP-77' }, { key: 'id_number', value: 'APP-77' },
    { key: 'aadhaar_number', label: 'Aadhaar number', value: '2345 6789 0124' }, // checksum-valid, fictional
    { key: 'email', value: 'neha(at)example' }, { key: 'phone', value: '12345' }, { key: 'pincode', value: '011001' },
  ] });
  const issues = run(doc);
  assert.equal(find(issues, /Application date .* is in the future/).severity, 'warning');
  assert.equal(find(issues, /Date of birth .* is in the future/).severity, 'error');
  assert.ok(!find(issues, /same number/), 'the generic ID number may repeat a specific one');
  const twice = run(normalizeExtraction({ docType: 'marksheet', fields: [
    { key: 'student_name', value: 'Asha Verma' }, { key: 'roll_number', value: '2401587' }, { key: 'enrollment_number', value: '2401587' },
  ] }));
  assert.equal(find(twice, /Roll number and Enrollment number have the same number \(2401587\)/)?.rule, 'id.duplicate');
  const aadhaar = find(issues, /full Aadhaar number/);
  assert.ok(aadhaar);
  assert.match(aadhaar.message, /XXXX XXXX 0124/, 'the message never repeats the full number');
  assert.doesNotMatch(aadhaar.message, /2345/);
  assert.ok(find(issues, /not a valid email/));
  assert.ok(find(issues, /not a valid phone/));
  assert.ok(find(issues, /not a valid PINCODE/));
  assert.ok(!find(issues, /applicant name is missing/i));
});

test('uncertain document type is reported as info', () => {
  const issues = run(normalizeExtraction({ docType: 'other', docTypeConfidence: 0.3, fields: [] }));
  assert.equal(find(issues, /document type is uncertain/).type, 'low_confidence');
});

test('low-confidence issues for required fields below 0.5', () => {
  const issues = lowConfidenceIssues([
    { key: 'a', label: 'A', required: true, value: 'x', confidence: 0.42 },
    { key: 'b', label: 'B', required: true, value: 'y', confidence: 0.9 },
    { key: 'c', label: 'C', required: false, value: 'z', confidence: 0.1 },
    { key: 'd', label: 'D', required: true, value: null, confidence: 0 },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'low_confidence');
  assert.deepEqual(issues[0].fieldKeys, ['a']);
});

test('pipeline: issues feed the confidence score and the overall score', () => {
  const text = ['invoice_number: INV-1 invoice_date: 12/03/2024 seller_name: Example Traders Pvt Ltd buyer_name: Sample Retail Co subtotal: Rs. 1,000.00 total_amount: Rs. 1,250.00'];
  const good = finalizeExtraction(invoiceDoc({ total: 'Rs. 1,250.00' }), { textByPage: text, ocrUsed: false, now });
  const total = good.fields.find(f => f.key === 'total_amount');
  assert.equal(total.confidenceDetail.validation, 0, 'error on the field lowers its validation score');
  assert.ok(good.issues.some(i => i.type === 'inconsistent'));
  assert.ok(good.overallConfidence < 0.9);
  assert.ok(amountsDiffer(100, 102) && !amountsDiffer(100, 100.5));
});

test('identity and tax numbers: Aadhaar checksum, PAN structure, GSTIN checksum', () => {
  // Valid, fictional numbers produce no issues.
  assert.deepEqual(run(invoiceDoc({ fields: [{ key: 'seller_pan', value: 'AAACE1234F' }] })), []);

  // GSTIN with a misread last character.
  let issues = run(invoiceDoc({ gstin: '27AAACE1234F1Z5' }));
  const gstin = find(issues, /fails the GSTIN checksum \(the last character should be "6"\)/);
  assert.equal(gstin?.severity, 'warning');
  assert.equal(gstin.type, 'format');

  // PAN with an impossible holder type, and one whose initial does not match the seller.
  issues = run(invoiceDoc({ fields: [{ key: 'seller_pan', value: 'AAADE1234F' }] }));
  assert.ok(find(issues, /Seller PAN AAADE1234F is not a valid PAN: its 4th letter "D" is not a valid holder type/));
  issues = run(invoiceDoc({ fields: [{ key: 'seller_pan', value: 'AAACX1234F' }] }));
  const initial = find(issues, /Seller PAN AAACX1234F: its 5th letter "X" should be "E", the initial of the name \(Example\)/);
  assert.equal(initial?.type, 'inconsistent');
  assert.deepEqual(initial.fieldKeys, ['seller_pan', 'seller_name']);

  // Without a separate PAN field, the PAN inside the GSTIN is checked.
  const buyer = normalizeExtraction({ docType: 'invoice', fields: [
    { key: 'buyer_name', value: 'Sample Retail Co' }, { key: 'buyer_gstin', value: '27AAFCS5678B1Z7' },
  ] });
  assert.ok(!find(run(buyer), /PAN inside|GSTIN checksum/), JSON.stringify(run(buyer)));
  const wrongBuyer = normalizeExtraction({ docType: 'invoice', fields: [
    { key: 'buyer_name', value: 'Demo Learning Centre' }, { key: 'buyer_gstin', value: '27AAFCS5678B1Z7' },
  ] });
  assert.ok(find(run(wrongBuyer), /The PAN inside Buyer GSTIN \(AAFCS5678B\): its 5th letter "S" should be "D"/));

  // Aadhaar: masked is fine; an impossible number is reported without repeating it.
  const id = (value, extra = []) => normalizeExtraction({ docType: 'identity_document', docTypeConfidence: 0.9, fields: [
    { key: 'document_name', value: 'Aadhaar card' }, { key: 'holder_name', value: 'Neha Rao' },
    { key: 'aadhaar_number', label: 'Aadhaar number', value }, ...extra,
  ] });
  assert.ok(!find(run(id('XXXX XXXX 4321')), /Aadhaar/));
  const bad = find(run(id('2345 6789 0125')), /not a valid Aadhaar number: its last digit fails the Verhoeff checksum/);
  assert.equal(bad?.severity, 'warning');
  assert.match(bad.message, /XXXX XXXX 0125/);
  assert.ok(find(run(id('1345 6789 0125')), /never start with 0 or 1/));

  // A PAN card: the ID number is checked against the holder's surname.
  const panCard = normalizeExtraction({ docType: 'identity_document', docTypeConfidence: 0.9, fields: [
    { key: 'document_name', value: 'PAN card' }, { key: 'holder_name', value: 'Arjun Nair' }, { key: 'id_number', value: 'ABCPK1234F' },
  ] });
  assert.ok(find(run(panCard), /PAN ABCPK1234F: its 5th letter "K" should be "N", the initial of the surname \(Nair\)/));
});

test('rule ids: every issue names a catalogued rule', async () => {
  const { RULES } = await import('../lib/validate.js');
  const { readFileSync } = await import('node:fs');
  const ids = new Set(RULES.map(r => r.id));
  assert.equal(ids.size, RULES.length, 'unique ids');
  // Literal ids in the source...
  const src = readFileSync(new URL('../lib/validate.js', import.meta.url), 'utf8');
  for (const [, id] of src.matchAll(/issue\('([a-z_.]+)'/g)) assert.ok(ids.has(id), `${id} is catalogued`);
  // ...and issues raised by the sample documents in these tests.
  const raised = [
    ...run(invoiceDoc({ total: 'Rs. 1,250.00', gstin: '27AAACE1234F1Z5' })),
    ...run(marksheetDoc({ total: '420', percentage: '86.5' })),
    ...run(certificateDoc({ issue: '20/08/2024', valid: '19/08/2023' })),
  ];
  assert.ok(raised.length > 4);
  for (const i of raised) assert.ok(ids.has(i.rule), `${i.rule} (${i.message})`);
});

test('dates: impossible calendar days and month-first dates', () => {
  const doc = normalizeExtraction({ docType: 'certificate', docTypeConfidence: 0.9, fields: [
    { key: 'certificate_title', value: 'Certificate of Merit' }, { key: 'recipient_name', value: 'Asha Verma' },
    { key: 'issuing_organization', value: 'Model School' }, { key: 'issue_date', value: '31/02/2024' },
    { key: 'valid_until', value: '03/25/2030' },
  ] });
  const issues = run(doc);
  assert.equal(find(issues, /Issue date "31\/02\/2024" is not a real calendar date/)?.rule, 'date.impossible');
  const mf = find(issues, /written month-first/);
  assert.equal(mf?.rule, 'date.month_first');
  assert.equal(mf.severity, 'info');
  assert.match(mf.message, /read as 2030-03-25/);
});

test('most required fields missing suggests the wrong document type', () => {
  const doc = normalizeExtraction({ docType: 'marksheet', docTypeLabel: 'Marksheet', docTypeConfidence: 0.7, fields: [
    { key: 'student_name', value: 'Asha Verma' },
  ] });
  const hint = find(run(doc), /required fields of a marksheet .* are missing; check that the document type is right/);
  assert.equal(hint?.rule, 'type.required_mostly_missing');
  assert.ok(!find(run(marksheetDoc()), /check that the document type/));
});
