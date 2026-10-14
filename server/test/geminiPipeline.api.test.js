import test from 'node:test';
import assert from 'node:assert/strict';
import { makePdf, makePng } from './helpers/files.js';
process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.DOXENTRA_ANALYSIS_PIPELINE = 'gemini';
process.env.AUTH_SECRET = 'hybrid-test';
process.env.VERCEL = '1';
const { default: app } = await import('../index.js');
const { setGeminiClient, setGeminiPool } = await import('../lib/ai.js');
const { GeminiKeyPool } = await import('../lib/geminiPool.js');
const { getDocument, getJob, updateJobItem, leaseJobItem } = await import('../lib/db.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const owner = { guestId: 'hybrid_workspace_1234567890' };
const headers = { 'x-guest-id': owner.guestId };
const text = 'Title: Example Document\nReference: REF-0042\nA clean paragraph with sufficient selectable text.';
const extraction = { docType: 'other', docTypeConfidence: 0.99, title: 'Example', language: 'en', summary: 'An example reference document.', entities: [],
  fields: [{ key: 'title', value: 'Example Document', confidence: 0.99, page: 1, sourceQuote: 'Title: Example Document' },
    { key: 'reference_number', value: 'REF-0042', confidence: 0.99, page: 1, sourceQuote: 'Reference: REF-0042' }],
  conceptMap: { nodes: [{ id: 'r', type: 'major', label: 'Example', desc: 'An example document with a reference.' },
    { id: 'h', type: 'header', label: 'Reference', parentId: 'r', desc: 'The reference identifies the example document.' }], links: [],
    metadata: { title: 'Example', description: 'An example document.', complexity: 2, category: 'General', roadmap: [], relatedModules: [] } },
};
const request = async (path, init) => { const res = await fetch(base + path, init); return { status: res.status, body: await res.json() }; };
test.after(() => { setGeminiClient(null); server.close(); });

test('Gemini API preserves upload/output/map contracts with per-page OCR', async () => {
  const calls = [];
  setGeminiClient({ models: { async generateContent(req) {
    calls.push(req);
    return { text: JSON.stringify(req.config.responseJsonSchema.properties.visibleFields
      ? { text: 'यह स्कैन किया गया पृष्ठ है।', visibleFields: [] } : extraction) };
  } } });
  const form = new FormData();
  form.append('files', new Blob([makePdf([[...text.split('\n')], [], [text]])], { type: 'application/pdf' }), 'mixed.pdf');
  const response = await request('/extract', { method: 'POST', headers, body: form });
  assert.equal(response.status, 200);
  const doc = response.body.documents[0];
  assert.equal(doc.success, true); assert.equal(doc.pageCount, 3); assert.equal(doc.ocrUsed, true);
  assert.equal(doc.fields.find(f => f.key === 'reference_number').value, 'REF-0042');
  assert.ok(doc.hasGraph); assert.ok(!Object.hasOwn(doc, 'pipeline'));
  assert.equal(calls.length, 2, 'one Gemini page OCR + one text-only analysis');
  assert.equal(calls[0].contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.ok(calls[1].contents[0].parts.every(part => !part.inlineData && !part.fileData));
  const map = await request(`/documents/${doc.id}/concept-map`, { method: 'POST', headers });
  assert.equal(map.body.cached, true); assert.ok(map.body.graph.nodes.length);
  const wrongOwner = await request(`/documents/${doc.id}`, { headers: { 'x-guest-id': 'unrelated_workspace_1234567890' } });
  assert.equal(wrongOwner.status, 404);
});

test('image Aadhaar checksums run before masking all stored and public text', async () => {
  const number = '2345 6789 0124';
  const aadhaarText = `Aadhaar\nAadhaar number: ${number}\nName: Asha Verma`;
  const calls = [];
  setGeminiClient({ models: { async generateContent(req) {
    calls.push(req);
    return { text: JSON.stringify(req.config.responseJsonSchema.properties.visibleFields
      ? { text: aadhaarText, visibleFields: [{ label: 'Aadhaar number', value: number, confidence: 0.99 }] }
      : { ...extraction, conceptMap: undefined, docType: 'identity_document', docSubtype: 'aadhaar', title: 'Aadhaar', fields: [
        { key: 'document_name', value: 'Aadhaar', confidence: 0.99, page: 1, sourceQuote: 'Aadhaar' },
        { key: 'id_number', value: number, confidence: 0.99, page: 1, sourceQuote: `Aadhaar number: ${number}` },
        { key: 'holder_name', value: 'Asha Verma', confidence: 0.99, page: 1, sourceQuote: 'Name: Asha Verma' },
      ] }) };
  } } });
  const form = new FormData();
  form.append('files', new Blob([makePng()], { type: 'image/png' }), 'aadhaar.png');
  const response = await request('/extract', { method: 'POST', headers, body: form });
  assert.equal(response.status, 200);
  const doc = response.body.documents[0];
  assert.equal(calls.length, 2, 'valid high-confidence ID needs no Stage 3');
  assert.equal(doc.fields.find(f => f.key === 'id_number').value, 'XXXX XXXX 0124');
  assert.ok(!doc.issues.some(i => i.rule === 'aadhaar.checksum'));
  const stored = await getDocument(doc.id, owner);
  assert.ok(!JSON.stringify(stored.extraction).includes(number));
  assert.ok(stored.extraction.rawTextByPage[0].includes('XXXX XXXX 0124'));
});

test('Gemini jobs checkpoint PDF chunks and merge maps without changing job routes', async () => {
  let calls = 0;
  setGeminiClient({ models: { async generateContent() { calls++; return { text: JSON.stringify(extraction) }; } } });
  const form = new FormData();
  form.append('file', new Blob([makePdf(Array.from({ length: 11 }, () => text.split('\n')))], { type: 'application/pdf' }), 'long-hybrid.pdf');
  const uploaded = await request('/uploads', { method: 'POST', headers, body: form });
  assert.equal(uploaded.status, 200);
  const created = await request('/jobs', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ path: uploaded.body.path, filename: 'long-hybrid.pdf', mimeType: 'application/pdf' }] }) });
  assert.equal(created.status, 202);
  const { id, items } = created.body.job;
  let job;
  for (let i = 0; i < 3; i++) {
    const processed = await request(`/jobs/${id}/items/${items[0].id}/process`, { method: 'POST', headers });
    assert.equal(processed.status, 200);
    job = processed.body.job;
    assert.equal(calls, i + 1);
    assert.equal(job.items[0].pageProgress.pagesCompleted, Math.min(5 * (i + 1), 11));
    assert.equal(job.items[0].status, i < 2 ? 'queued' : 'done');
    assert.ok(!JSON.stringify(job).includes('graphChunks'));
  }
  const document = await request(`/documents/${job.items[0].documentId}`, { headers });
  assert.equal(document.body.pageCount, 11); assert.equal(document.body.hasGraph, true);
  const map = await request(`/documents/${document.body.id}/concept-map`, { method: 'POST', headers });
  assert.equal(map.body.cached, true); assert.equal(map.body.graph.nodes.length, 4);
  assert.equal(calls, 3, 'cached map and quiz require no extra AI call');
});

test('Stage 2 outage preserves image OCR with existing fallbackUsed/warning contract', async () => {
  setGeminiClient({ models: { async generateContent(req) {
    if (req.config.responseJsonSchema.properties.visibleFields) return { text: JSON.stringify({
      text: 'TAX INVOICE\nInvoice No: INV-42\nDate: 01/02/2024\nTotal: Rs. 590.00', visibleFields: [],
    }) };
    throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
  } } });
  const form = new FormData();
  form.append('files', new Blob([makePng(3, 3)], { type: 'image/png' }), 'invoice-photo.png');
  const response = await request('/extract', { method: 'POST', headers, body: form });
  assert.equal(response.status, 200);
  const doc = response.body.documents[0];
  assert.equal(doc.success, true); assert.equal(doc.fallbackUsed, true);
  assert.match(doc.warning, /basic extraction/);
  assert.equal(doc.fields.find(f => f.key === 'invoice_number').value, 'INV-42');
});

test('quota exhaustion keeps a checkpointed job queued, gates retries, and resumes the same file', async () => {
  const form = new FormData();
  form.append('file', new Blob([makePdf(Array.from({ length: 6 }, () => []))], { type: 'application/pdf' }), 'quota-scans.pdf');
  const uploaded = await request('/uploads', { method: 'POST', headers, body: form });
  const created = await request('/jobs', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ path: uploaded.body.path, filename: 'quota-scans.pdf', mimeType: 'application/pdf' }] }) });
  const { id, items } = created.body.job;
  const itemId = items[0].id;
  const processPath = `/jobs/${id}/items/${itemId}/process`;
  const healthy = { models: { async generateContent(req) {
    return { text: JSON.stringify(req.config.responseJsonSchema.properties.visibleFields ? { text, visibleFields: [] } : extraction) };
  } } };
  setGeminiClient(healthy);
  const first = await request(processPath, { method: 'POST', headers });
  assert.equal(first.body.job.items[0].status, 'queued');
  assert.equal(first.body.job.items[0].pageProgress.pagesCompleted, 5);
  let calls = 0;
  setGeminiPool(new GeminiKeyPool(['first', 'second'], { createClient: () => ({ models: { async generateContent() {
    calls++;
    throw Object.assign(new Error('{"retryDelay":"120s"}'), { status: 429 });
  } } }) }));
  try {
    // Repeated quota windows must not consume the ordinary failure budget.
    for (let cycle = 0; cycle < 3; cycle++) {
      const deferred = await request(processPath, { method: 'POST', headers });
      const item = deferred.body.job.items[0];
      assert.equal(item.status, 'queued'); assert.equal(item.stage, 'retrying');
      assert.equal(item.processable, false); assert.equal(item.attempts, 0);
      assert.equal(item.pageProgress.pagesCompleted, 5);
      assert.ok(item.lastError); assert.ok(!item.error);
      assert.equal(deferred.body.job.status, 'running');
      assert.ok(!Object.hasOwn(item, 'nextAttemptAt'), 'cooldown is private; public schema stays unchanged');
      const before = calls;
      await request(processPath, { method: 'POST', headers });
      assert.equal(calls, before, 'direct duplicate requests also respect cooldown');
      assert.equal(await leaseJobItem(id, itemId, 75_000), null, 'DB lease is gated atomically');
      const stored = await getJob(id, owner);
      assert.equal(stored.items[0].checkpoint.nextPage, 5);
      assert.ok(new Date(stored.items[0].nextAttemptAt) > new Date());
      await updateJobItem(id, itemId, { nextAttemptAt: new Date(Date.now() - 1) });
    }
    setGeminiClient(healthy);
    const resumed = await request(processPath, { method: 'POST', headers });
    assert.equal(resumed.body.job.items[0].status, 'done');
    const doc = await request(`/documents/${resumed.body.job.items[0].documentId}`, { headers });
    assert.equal(doc.body.pageCount, 6); assert.equal(doc.body.fallbackUsed, false);
    assert.equal(doc.body.filename, 'quota-scans.pdf');
  } finally { setGeminiClient(null); }
});
