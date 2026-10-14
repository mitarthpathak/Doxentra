import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const headers = { 'x-guest-id': 'workflow_upload_1234567890123456' };
test.after(() => server.close());

async function upload(filename) {
  const form = new FormData();
  const buffer = readFileSync(new URL(`../../samples/${filename}`, import.meta.url));
  form.append('files', new Blob([buffer], { type: 'application/pdf' }), filename);
  const response = await fetch(`${base}/extract`, { method: 'POST', body: form, headers });
  assert.equal(response.status, 200);
  const doc = (await response.json()).documents[0];
  assert.equal(doc.success, true);
  return doc;
}
const json = (path, method = 'GET', body) => fetch(base + path, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('uploaded demo files drive the source-backed checklist and correction refresh', async () => {
  const old = await upload('workflow-invoice-v1.pdf');
  const current = await upload('workflow-invoice-v2.pdf');
  const circular = await upload('workflow-eligibility-circular.pdf');
  assert.equal(old.docType, 'invoice');
  assert.equal(current.fields.find(f => f.key === 'bank_account_number').value, '987654321098');
  const twin = (await (await json(`/documents/${current.id}/twin`)).json()).twin;
  assert.deepEqual(twin.changes.filter(c => ['total_amount', 'bank_account_number'].includes(c.key)).map(c => c.key), ['total_amount', 'bank_account_number']);

  const built = await json(`/policies/${circular.id}/build`, 'POST');
  assert.equal(built.status, 200);
  const requirements = (await built.json()).policy.requirements;
  assert.deepEqual(requirements.map(r => r.kind), ['document_required', 'document_required', 'date_on_or_after']);
  assert.ok(requirements.every(r => r.source.page === 1 && r.source.quote));

  const made = await json('/packets', 'POST', { title: 'Invoice review', documentIds: [old.id, current.id], policyId: circular.id });
  assert.equal(made.status, 201);
  const packetId = (await made.json()).packet.id;
  const before = (await (await json(`/packets/${packetId}`)).json()).packet;
  assert.ok(before.tasks.some(t => t.kind === 'policy' && t.status === 'missing'));
  assert.ok(before.tasks.some(t => t.kind === 'conflict' && /different totals/.test(t.message)));

  const corrected = await json(`/documents/${current.id}/fields/total_amount`, 'PATCH', { action: 'correct', value: 'Rs. 18,500.00' });
  assert.equal(corrected.status, 200);
  const after = (await (await json(`/packets/${packetId}`)).json()).packet;
  assert.equal(after.tasks.some(t => t.kind === 'conflict' && /different totals/.test(t.message)), false);
  assert.ok(after.tasks.some(t => t.kind === 'policy' && t.status === 'missing'));

  const marksheet = await upload('d-marksheet-wrong-total.pdf');
  const certificate = await upload('c-certificate-issued-after-expiry.pdf');
  const studentMade = await json('/packets', 'POST', { title: 'Student eligibility', documentIds: [marksheet.id, certificate.id], policyId: circular.id });
  assert.equal(studentMade.status, 201);
  const studentId = (await studentMade.json()).packet.id;
  const student = (await (await json(`/packets/${studentId}`)).json()).packet;
  assert.equal(student.checklist.find(c => c.rule.docType === 'marksheet').status, 'met');
  assert.equal(student.checklist.find(c => c.rule.kind === 'date_on_or_after').status, 'mismatch');
  assert.ok(student.tasks.some(t => t.kind === 'expired'));
});
