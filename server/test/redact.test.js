import test from 'node:test';
import assert from 'node:assert/strict';
import { maskDate, maskEmail, maskField, maskKeepLast, maskName, redactDocument } from '../lib/redact.js';

test('masks: keep the last digits, initials, the year of birth', () => {
  assert.equal(maskKeepLast('2345 6789 0124'), 'XXXX XXXX 0124');
  assert.equal(maskKeepLast('+91 98765 43210'), '+XX XXXXX X3210');
  assert.equal(maskKeepLast('ADM/2024/1093', 3), 'XXX/XXXX/X093');
  assert.equal(maskName('Smt. Asha  Verma'), 'A. V.');
  assert.equal(maskName('आशा वर्मा'), 'आ. व.');
  assert.equal(maskEmail('neha.rao@example.com'), 'n***@example.com');
  assert.equal(maskDate('14/03/2006'), 'XX/XX/2006');
  assert.equal(maskDate('5 September 2006'), 'X XXX 2006');
  assert.equal(maskDate('२०/०१/२००६'), 'XX/XX/2006');
});

test('which fields are personal data', () => {
  const kind = f => maskField({ value: 'x', ...f })?.kind ?? null;
  assert.equal(kind({ key: 'student_name' }), 'name');
  assert.equal(kind({ key: 'father_or_guardian_name' }), 'name');
  assert.equal(kind({ key: 'seller_name' }), null, 'a business');
  assert.equal(kind({ key: 'signatory_name' }), null, 'an official in that role');
  assert.equal(kind({ key: 'roll_number' }), 'id');
  assert.equal(kind({ key: 'invoice_number' }), null);
  assert.equal(kind({ key: 'date_of_birth' }), 'dob');
  assert.equal(kind({ key: 'issue_date' }), null);
  assert.equal(kind({ key: 'phone', type: 'phone' }), 'phone');
  assert.equal(kind({ key: 'address' }), 'address');
  assert.equal(kind({ key: 'seller_address' }), null);
  // PAN / GSTIN: only an individual's (4th PAN letter P).
  assert.equal(kind({ key: 'seller_pan', format: 'pan', value: 'ABCPE1234F' }), 'pan');
  assert.equal(kind({ key: 'seller_pan', format: 'pan', value: 'AAACE1234F' }), null);
  assert.equal(kind({ key: 'seller_gstin', format: 'gstin', value: '27ABCPE1234F1Z5' }), 'pan');
  assert.equal(kind({ key: 'seller_gstin', format: 'gstin', value: '27AAACE1234F1Z6' }), null);
  assert.equal(maskField({ key: 'pincode', format: 'pincode', value: '440010' }).masked, '440XXX');
});

test('redactDocument: no personal value survives anywhere in the document', () => {
  const doc = {
    filename: 'form-neha-rao.pdf', title: 'Application – Neha Rao',
    summary: 'Neha Rao (born 05/09/2006), daughter of PRAKASH RAO, phone 98765 43210, neha.rao@example.com, 7 Demo Colony, Nagpur.',
    fields: [
      { key: 'applicant_name', label: 'Applicant', value: 'Neha Rao', normalizedValue: 'Neha Rao', sourceQuote: 'Name: Neha Rao',
        review: { status: 'confirmed', by: 'clerk@example.com', at: '2026-01-01T00:00:00Z', original: { value: 'Neha Rao', normalizedValue: 'Neha Rao', sourceQuote: 'Name: Neha Rao', page: 1 } } },
      { key: 'father_or_guardian_name', label: 'Father', value: 'Prakash Rao' },
      { key: 'date_of_birth', label: 'DOB', type: 'date', value: '05/09/2006', normalizedValue: '2006-09-05' },
      { key: 'phone', label: 'Phone', type: 'phone', value: '98765 43210', normalizedValue: '+919876543210' },
      { key: 'email', label: 'Email', type: 'email', value: 'neha.rao@example.com' },
      { key: 'address', label: 'Address', value: '7 Demo Colony, Nagpur' },
      { key: 'position_or_course', label: 'Course', value: 'B.Sc. Computer Science' },
    ],
    entities: [{ type: 'PERSON', value: 'Neha Rao' }, { type: 'PERSON', value: 'Dr. Meera Iyer' }, { type: 'ORG', value: 'Example College' }],
    tables: [{ title: 'Contacts', columns: ['Name', 'Phone'], rows: [['Neha Rao', '+91 98765 43210']] }],
    issues: [{ message: 'Date of birth 2006-09-05 of Neha Rao is fine.' }],
    review: { status: 'approved', approvedBy: 'clerk@example.com' },
    audit: [{ action: 'correct', fieldKey: 'applicant_name', from: 'Neha Raao', to: 'Neha Rao', by: 'clerk@example.com', note: 'Neha Rao said so' }],
  };
  const r = redactDocument(doc);
  const json = JSON.stringify(r);
  for (const secret of ['Neha', 'Prakash', 'PRAKASH', '05/09', '2006-09-05', '98765', '+9198765', 'neha.rao', 'Demo Colony', 'clerk@', 'Meera', 'Raao']) {
    assert.ok(!json.includes(secret), `${secret} leaked: ${json}`);
  }
  assert.equal(r.filename, 'form-NR.pdf');
  assert.equal(r.fields.find(f => f.key === 'position_or_course').value, 'B.Sc. Computer Science');
  assert.equal(r.entities[2].value, 'Example College');
  assert.equal(r.audit[0].from, 'N. R.');
  assert.deepEqual(r.fields[0].review.original, { value: 'N. R.', normalizedValue: 'N. R.', sourceQuote: 'Name: N. R.', page: 1 });
  assert.deepEqual(r.redaction.fields.map(f => f.kind), ['name', 'name', 'dob', 'phone', 'email', 'address']);
  assert.equal(r.redacted, true);
  assert.equal(doc.fields[0].value, 'Neha Rao', 'the input is not changed');
});
