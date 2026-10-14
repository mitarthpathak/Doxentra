import test from 'node:test';
import assert from 'node:assert/strict';
import { documentTwin } from '../lib/twins.js';
import { evaluatePolicy, verifyRequirements } from '../lib/policy.js';
import { packetReview } from '../lib/packet.js';

const doc = (id, type, filename, fields, createdAt, extra = {}) => ({ _id: id, filename, createdAt, file: { path: `${id}.pdf` },
  extraction: { docType: type, fields: Object.entries(fields).map(([key, value]) => ({ key, label: key, value, page: 1, sourceQuote: `${key}: ${value}`, confidence: 0.9, required: true })) }, ...extra });

test('twin compares the same invoice and preserves both original page references', () => {
  const old = doc('a', 'invoice', 'invoice-v1.pdf', { invoice_number: 'INV-42', seller_name: 'Example Traders', total_amount: 'Rs. 18,500', bank_account_number: '1234' }, '2026-01-01');
  const next = doc('b', 'invoice', 'invoice-v2.pdf', { invoice_number: 'INV-42', seller_name: 'Example Traders', total_amount: 'Rs. 28,500', bank_account_number: '9876' }, '2026-02-01');
  const twin = documentTwin(next, [old, next]);
  assert.equal(twin.previousId, 'a');
  assert.deepEqual(twin.changes.map(c => c.key), ['total_amount', 'bank_account_number']);
  assert.equal(twin.changes[0].before.page, 1);
  assert.equal(twin.changes[0].after.sourceQuote, 'total_amount: Rs. 28,500');
  assert.equal(documentTwin(next, [next]), null);
  assert.equal(documentTwin({ ...next, fileHash: 'same' }, [{ ...old, fileHash: 'same' }, { ...next, fileHash: 'same' }]), null);
});

test('policy accepts only requirements supported by the cited circular line', () => {
  const lines = [{ id: 'p1l3', page: 1, line: 3, text: 'Submit the marksheet by 15/10/2026.' }];
  const proposed = [
    { label: 'Submit marksheet', kind: 'document_required', docType: 'marksheet', sourceLineId: 'p1l3', quote: lines[0].text },
    { label: 'Invented amount', kind: 'field_equals', docType: 'invoice', fieldKey: 'total_amount', expected: '5000', sourceLineId: 'p1l3', quote: lines[0].text },
    { label: 'Invalid citation', kind: 'document_required', docType: 'certificate', sourceLineId: 'p9l2', quote: 'Submit certificate' },
  ];
  const rules = verifyRequirements(proposed, lines);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].source, { page: 1, line: 3, quote: lines[0].text });
});

test('packet priorities update from current corrected values and required proof', () => {
  const circular = doc('p', 'institutional_record', 'circular.pdf', {}, '2026-01-01', { policy: { requirements: [
    { id: 'r1', label: 'Marksheet', kind: 'document_required', docType: 'marksheet', source: { page: 1, line: 2, quote: 'Submit marksheet' } },
    { id: 'r2', label: 'Valid certificate', kind: 'date_on_or_before', docType: 'certificate', fieldKey: 'valid_until', expected: '2026-12-31', source: { page: 1, line: 3, quote: 'Certificate valid until 31/12/2026' } },
  ] } });
  const certificate = doc('c', 'certificate', 'certificate.pdf', { valid_until: '01/01/2027' }, '2026-02-01');
  const packet = { _id: 'packet', title: 'Case', documentIds: ['c'], policyId: 'p' };
  const first = packetReview(packet, [certificate], circular, new Date('2026-10-14'));
  assert.equal(first.checklist[0].status, 'missing');
  assert.equal(first.checklist[1].status, 'mismatch');
  assert.equal(first.tasks[0].priority, 0);
  const corrected = doc('c', 'certificate', 'certificate.pdf', { valid_until: '01/12/2026' }, '2026-02-01');
  const second = packetReview(packet, [corrected], circular, new Date('2026-10-14'));
  assert.equal(second.checklist[1].status, 'met');
  assert.equal(second.tasks.some(t => t.kind === 'policy' && t.ruleId === 'r2'), false);
});

test('expiry threshold uses on or after and rejects an unsupported date', () => {
  const line = { id: 'p1l1', page: 1, line: 1, text: 'Certificate must remain valid through 31/12/2026.' };
  const rules = verifyRequirements([
    { label: 'Valid certificate', kind: 'date_on_or_after', docType: 'certificate', fieldKey: 'valid_until', expected: '2026-12-31', sourceLineId: line.id, quote: line.text },
    { label: 'Made up date', kind: 'date_on_or_after', docType: 'certificate', fieldKey: 'valid_until', expected: '2027-12-31', sourceLineId: line.id, quote: line.text },
  ], [line]);
  assert.equal(rules.length, 1);
  const expired = doc('a', 'certificate', 'a.pdf', { valid_until: '01/12/2026' }, '2026-01-01');
  const valid = doc('b', 'certificate', 'b.pdf', { valid_until: '01/01/2027' }, '2026-01-01');
  assert.equal(evaluatePolicy(rules, [expired])[0].status, 'mismatch');
  assert.equal(evaluatePolicy(rules, [valid])[0].status, 'met');
});
