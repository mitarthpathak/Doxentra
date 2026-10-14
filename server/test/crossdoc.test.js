import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraction } from '../lib/extract.js';
import { crossDocumentIssues, groupPeople, personRecords } from '../lib/crossdoc.js';

let n = 0;
const doc = (docType, fields, extra = {}) => ({
  _id: `d${++n}`, filename: `${docType}-${n}.pdf`, ...extra,
  extraction: { ...normalizeExtraction({ docType, docTypeConfidence: 0.9, title: `${docType} ${n}`, fields }), title: `${docType} ${n}` },
});
const marksheet = (over = {}) => doc('marksheet', [
  { key: 'student_name', value: 'Asha Verma' }, { key: 'roll_number', value: '2401587' },
  { key: 'father_or_guardian_name', value: 'Suresh Verma' }, { key: 'date_of_birth', value: '14/02/2006' },
  ...Object.entries(over).map(([key, value]) => ({ key, value })),
]);
const idCard = fields => doc('identity_document', [{ key: 'document_name', value: 'Student ID card' }, ...fields]);
const rules = issues => issues.map(i => `${i.severity}:${i.rule}`).sort();

test('same roll number: conflicting date of birth is an error, father spelt differently a warning', () => {
  const issues = crossDocumentIssues([
    marksheet(),
    idCard([{ key: 'holder_name', value: 'Asha Verma' }, { key: 'id_number', value: '2401587' },
      { key: 'father_or_guardian_name', value: 'Suresh Varma' }, { key: 'date_of_birth', value: '14/03/2006' }]),
  ]);
  assert.deepEqual(rules(issues), ['error:cross.dob_mismatch', 'warning:cross.father_mismatch']);
  const dob = issues[0];
  assert.match(dob.message, /Date of birth of Asha Verma differs: "14\/02\/2006" in marksheet \d+ but "14\/03\/2006" in identity_document \d+ \(both documents have Roll no\. 2401587\)/);
  assert.equal(dob.type, 'cross_document');
  assert.deepEqual(dob.refs.map(r => r.fieldKey), ['date_of_birth', 'date_of_birth']);
});

test('linked by name only: conflicts are softer, and the same date written differently is no conflict', () => {
  const issues = crossDocumentIssues([
    marksheet(),
    idCard([{ key: 'holder_name', value: 'Ms. Asha Verma' }, { key: 'date_of_birth', value: '14 March 2006' }, { key: 'father_or_guardian_name', value: 'Suresh Verma' }]),
  ]);
  assert.deepEqual(rules(issues), ['warning:cross.dob_mismatch']);
  assert.match(issues[0].message, /matched by name only; they may be two different people/);
  assert.deepEqual(crossDocumentIssues([marksheet(), idCard([{ key: 'holder_name', value: 'Asha Verma' }, { key: 'date_of_birth', value: '14 February 2006' }])]), []);
});

test('a name spelt differently under the same id; an id carrying a different name entirely', () => {
  let issues = crossDocumentIssues([marksheet(), idCard([{ key: 'holder_name', value: 'Asha Varma' }, { key: 'id_number', value: '2401587' }])]);
  assert.deepEqual(rules(issues), ['warning:cross.name_variant']);
  issues = crossDocumentIssues([marksheet(), idCard([{ key: 'holder_name', value: 'Rahul Khanna' }, { key: 'id_number', value: '2401587' }, { key: 'date_of_birth', value: '01/01/2001' }])]);
  assert.deepEqual(rules(issues), ['error:cross.id_conflict'], 'different people: their dates of birth are not compared');
  assert.match(issues[0].message, /Roll no\. 2401587 belongs to "Asha Verma" in .* but to "Rahul Khanna"/);
});

test('masked numbers and different people do not link', () => {
  const a = doc('application_form', [{ key: 'applicant_name', value: 'Neha Rao' }, { key: 'id_number', value: 'XXXX XXXX 4321' }, { key: 'date_of_birth', value: '05/09/2006' }]);
  const b = doc('application_form', [{ key: 'applicant_name', value: 'Arjun Nair' }, { key: 'id_number', value: 'XXXX XXXX 4321' }, { key: 'date_of_birth', value: '11/11/2004' }]);
  assert.deepEqual(crossDocumentIssues([a, b]), []);
  assert.equal(groupPeople(personRecords([a, b])).length, 2);
});

test('invoices: duplicate number with a different total, the same invoice twice, one GSTIN under two names', () => {
  const inv = (total, extra = []) => doc('invoice', [
    { key: 'invoice_number', value: 'ET/2024-25/0147' }, { key: 'seller_name', value: 'Example Traders Pvt Ltd' },
    { key: 'seller_gstin', value: '27AAACE1234F1Z6' }, { key: 'total_amount', value: total }, ...extra,
  ]);
  let issues = crossDocumentIssues([inv('₹ 18,880.00'), inv('₹ 18,762.00')]);
  assert.deepEqual(rules(issues), ['error:cross.invoice_conflict']);
  assert.match(issues[0].message, /different totals: ₹18,880 in .* but ₹18,762/);
  issues = crossDocumentIssues([inv('₹ 18,880.00'), inv('₹ 18,880.00')]);
  assert.deepEqual(rules(issues), ['warning:cross.invoice_duplicate']);
  const other = doc('invoice', [{ key: 'invoice_number', value: 'Z-1' }, { key: 'seller_name', value: 'Totally Different Agencies' }, { key: 'seller_gstin', value: '27AAACE1234F1Z6' }]);
  issues = crossDocumentIssues([inv('₹ 10.00'), other]);
  assert.deepEqual(rules(issues), ['warning:cross.gstin_name_conflict']);
});

test('documentId keeps only the issues involving that document', () => {
  const m = marksheet();
  const i = idCard([{ key: 'holder_name', value: 'Asha Verma' }, { key: 'id_number', value: '2401587' }, { key: 'date_of_birth', value: '14/03/2006' }]);
  const unrelated = doc('certificate', [{ key: 'recipient_name', value: 'Rohan Mehta' }]);
  assert.equal(crossDocumentIssues([m, i, unrelated], { documentId: m._id }).length, 1);
  assert.equal(crossDocumentIssues([m, i, unrelated], { documentId: unrelated._id }).length, 0);
});
