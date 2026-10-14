import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const { saveGraph } = await import('../lib/db.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());
const guest = 'workflow_guest_1234567890123456';
const headers = { 'x-guest-id': guest, 'content-type': 'application/json' };
const request = (path, method = 'GET', body, h = headers) => fetch(base + path, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) });
const field = (key, value) => ({ key, label: key, value, page: 1, sourceQuote: `${key}: ${value}`, confidence: 0.9, required: true });
const save = (filename, type, values, createdAt, text = '') => saveGraph({ filename, guestId: guest, source: 'ai', createdAt,
  file: { path: filename }, extraction: { docType: type, docTypeLabel: type, title: filename, fields: Object.entries(values).map(([k, v]) => field(k, v)),
    rawTextByPage: [text], pageCount: 1, issues: [], overallConfidence: 0.9 } });

test('policy build, packet checks and twin decision are owner scoped and audited', async () => {
  const circular = await save('rules.pdf', 'institutional_record', {}, '2026-01-01', 'Submit the marksheet for eligibility.\nThe certificate must remain valid through 31/12/2026.');
  const marksheet = await save('marksheet.pdf', 'marksheet', { student_name: 'Asha', roll_number: '12345' }, '2026-01-02');
  const prior = await save('invoice-v1.pdf', 'invoice', { invoice_number: 'INV-1', seller_name: 'Example Traders', total_amount: 'Rs. 18,500', bank_account_number: '1234' }, '2026-01-03');
  const next = await save('invoice-v2.pdf', 'invoice', { invoice_number: 'INV-1', seller_name: 'Example Traders', total_amount: 'Rs. 28,500', bank_account_number: '9876' }, '2026-01-04');
  assert.equal((await request(`/policies/${circular._id}/build`, 'POST', null, { 'x-guest-id': 'another_guest_123456789012345' })).status, 404);
  const policyResponse = await request(`/policies/${circular._id}/build`, 'POST');
  assert.equal(policyResponse.status, 200);
  const policy = (await policyResponse.json()).policy;
  assert.equal(policy.requirements[0].source.quote, 'Submit the marksheet for eligibility.');
  assert.equal(policy.requirements[1].kind, 'date_on_or_after');
  const created = await request('/packets', 'POST', { title: 'Asha application', documentIds: [marksheet._id, next._id], policyId: String(circular._id) });
  assert.equal(created.status, 201);
  const packetId = (await created.json()).packet.id;
  const packet = (await (await request(`/packets/${packetId}`)).json()).packet;
  assert.equal(packet.checklist[0].status, 'met');
  assert.equal(packet.changes[0].twin.changes.length, 2);
  assert.equal((await request(`/packets/${packetId}`, 'GET', null, { 'x-guest-id': 'another_guest_123456789012345' })).status, 404);
  const twin = (await (await request(`/documents/${next._id}/twin`)).json()).twin;
  assert.equal(twin.previousId, String(prior._id));
  assert.equal((await request(`/documents/${next._id}/twin/review`, 'POST', { action: 'approve', fingerprint: 'stale' })).status, 409);
  const reviewed = await request(`/documents/${next._id}/twin/review`, 'POST', { action: 'needs_review', fingerprint: twin.fingerprint });
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json()).document.audit.at(-1).action, 'twin_needs_review');
});
