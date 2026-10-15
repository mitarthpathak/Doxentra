import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './helpers/files.js';
import { fakeGemini } from './helpers/fakeGemini.js';
import { startFakeSupabase } from './helpers/fakeSupabase.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.SUPABASE_SECRET_KEY = '';

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const { updateJobItem } = await import('../lib/db.js');
const { maxDirectUploadBytes, resetStorageForTests } = await import('../lib/storage.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const invoice = JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url)));
const invoicePdf = (tag = Math.random()) => makePdf([[
  'TAX INVOICE', 'Invoice No: INV-2024-0042', 'Date: 12/03/2024', 'Seller: Example Traders Pvt Ltd', 'GSTIN: 27AAACE1234F1Z6',
  'Bill To: Sample Retail Co', 'Subtotal: Rs. 1,000.00', 'GST 18%: Rs. 180.00', 'Total: Rs. 1,180.00', `Ref ${tag}`,
]]);

const guest = () => ({ 'x-guest-id': `g${Date.now()}${Math.random().toString(36).slice(2)}aaaaaaaaaaaa`.slice(0, 40) });
const json = (headers, body) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (path, init = {}) => {
  const r = await fetch(base + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function directUpload(headers, bytes, name = 'invoice.pdf', type = 'application/pdf') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return call('/uploads', { method: 'POST', body: fd, headers });
}

async function waitForJob(headers, id, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call(`/jobs/${id}`, { headers });
    if (body.job.status !== 'running') return body.job;
    await Promise.all(body.job.items.filter(i => i.processable).map(i => call(`/jobs/${id}/items/${i.id}/process`, { method: 'POST', headers })));
    if (Date.now() > until) throw new Error(`job still running: ${JSON.stringify(body.job)}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('uploads and jobs need an owner (account or guest workspace)', async () => {
  assert.equal((await call('/uploads/sign', json({}, { filename: 'a.pdf' }))).status, 401);
  assert.equal((await call('/jobs', json({}, { items: [] }))).status, 401);
  assert.equal((await call('/jobs/abc')).status, 401);
  // Malformed guest ids are ignored.
  assert.equal((await call('/jobs/abc', { headers: { 'x-guest-id': 'short' } })).status, 401);
});

test('direct mode: upload, queue a job, poll it to completion, open the document', async () => {
  const g = guest();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    const sign = await call('/uploads/sign', json(g, { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1000 }));
    assert.equal(sign.status, 200);
    assert.equal(sign.body.mode, 'direct', 'without Supabase the file goes to the API');

    const bytes = invoicePdf();
    const up = await directUpload(g, bytes);
    assert.equal(up.status, 200);
    assert.match(up.body.path, /^uploads\/g_/);
    assert.equal(up.body.driver, 'memory');

    const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'invoice.pdf', mimeType: 'application/pdf', size: bytes.length, quality: { width: 10, blurScore: 0.2, junk: { nested: 1 } } }] }));
    assert.equal(created.status, 202);
    assert.equal(created.body.job.total, 1);
    assert.equal(created.body.job.items[0].status, 'queued');
    const polled = await call(`/jobs/${created.body.job.id}`, { headers: g });
    assert.equal(polled.body.job.items[0].status, 'queued', 'GET must not process files');
    assert.equal((await call(`/jobs/${created.body.job.id}/items/${created.body.job.items[0].id}/process`, { method: 'POST', headers: guest() })).status, 404);

    const job = await waitForJob(g, created.body.job.id);
    assert.equal(job.status, 'done');
    const item = job.items[0];
    assert.equal(item.progress, 100);
    assert.ok(item.documentId);

    const doc = await call(`/documents/${item.documentId}`, { headers: g });
    assert.equal(doc.status, 200);
    assert.equal(doc.body.docType, 'invoice');
    // Other guests and anonymous requests cannot see it.
    assert.equal((await call(`/documents/${item.documentId}`, { headers: guest() })).status, 404);
    assert.equal((await call(`/documents/${item.documentId}`)).status, 401);
    assert.equal((await call(`/jobs/${created.body.job.id}`, { headers: guest() })).status, 404);

    // The original is stored for the page preview.
    const fileUrl = await call(`/documents/${item.documentId}/file-url`, { headers: g });
    assert.equal(fileUrl.body.external, false);
    const file = await fetch(`http://127.0.0.1:${server.address().port}${fileUrl.body.url}`, { headers: g });
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(bytes));
  } finally {
    setGeminiClient(null);
  }
});

test('jobs only accept files the same owner uploaded', async () => {
  const a = guest();
  const b = guest();
  const up = await directUpload(a, invoicePdf());
  const stolen = await call('/jobs', json(b, { items: [{ path: up.body.path, filename: 'x.pdf' }] }));
  assert.equal(stolen.status, 403);
  assert.equal((await call('/jobs', json(a, { items: [{ path: `${up.body.path}/../../x`, filename: 'x.pdf' }] }))).status, 403);
  assert.equal((await call('/jobs', json(a, { items: Array.from({ length: 11 }, () => ({ path: up.body.path })) }))).status, 400);
});

test('a failing file fails its item only; bad files are rejected at upload', async () => {
  const g = guest();
  const fake = await directUpload(g, Buffer.from('not a pdf'), 'fake.pdf');
  assert.equal(fake.status, 400);
  assert.match(fake.body.error, /not a valid PDF/);

  // A scanned PDF without the AI cannot be read: that item fails with a clear message.
  const scan = await directUpload(g, makePdf([[], []]), 'scan.pdf');
  const ok = await directUpload(g, invoicePdf());
  // The AI answers text requests and is "busy" for files (the scan), whichever comes first.
  setGeminiClient({ models: { async generateContent(req) {
    if (req.contents[0].parts.some(p => p.inlineData)) throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
    return { text: JSON.stringify(invoice), modelVersion: req.model };
  } } });
  try {
    const created = await call('/jobs', json(g, { items: [
      { path: ok.body.path, filename: 'ok.pdf', mimeType: 'application/pdf' },
      { path: scan.body.path, filename: 'scan.pdf', mimeType: 'application/pdf' },
    ] }));
    const job = await waitForJob(g, created.body.job.id);
    assert.equal(job.status, 'partial');
    const failed = job.items.find(i => i.status === 'failed');
    assert.equal(failed.filename, 'scan.pdf');
    assert.match(failed.error, /no selectable text/);
    assert.ok(job.items.find(i => i.status === 'done').documentId);
  } finally {
    setGeminiClient(null);
  }
});

test('a poll resumes an item whose worker died (expired lease)', async () => {
  const g = guest();
  const up = await directUpload(g, invoicePdf());
  // No AI and a digital PDF: the rule-based fallback finishes quickly.
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'inv.pdf', mimeType: 'application/pdf' }] }));
  const id = created.body.job.id;
  await waitForJob(g, id);
  // Pretend the worker died mid-way: running with an expired lease.
  const itemId = created.body.job.items[0].id;
  await updateJobItem(id, itemId, { status: 'running', stage: 'extracting', leaseUntil: new Date(Date.now() - 1000), attempts: 1, documentId: null });
  const job = await waitForJob(g, id);
  assert.equal(job.status, 'done');
  assert.ok(job.items[0].documentId);

  // A second death after the retry: the item fails instead of looping.
  await updateJobItem(id, itemId, { status: 'running', leaseUntil: new Date(Date.now() - 1000), attempts: 2 });
  const failed = await waitForJob(g, id);
  assert.equal(failed.items[0].status, 'failed');
  assert.match(failed.items[0].error, /took too long/);
});

test('signing in claims the guest workspace', async () => {
  const g = guest();
  const up = await directUpload(g, invoicePdf());
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'mine.pdf', mimeType: 'application/pdf' }] }));
  const job = await waitForJob(g, created.body.job.id);
  const signup = await call('/auth/signup', json({}, { email: `c${Date.now()}@example.com`, password: 'secret12', phone: '1', age: 30 }));
  const auth = { authorization: `Bearer ${signup.body.token}` };
  const claim = await call('/guest/claim', { method: 'POST', headers: { ...auth, ...g } });
  assert.equal(claim.body.moved, 1);
  const list = await call('/documents', { headers: auth });
  assert.deepEqual(list.body.documents.map(d => d.id), [job.items[0].documentId]);
  assert.equal((await call(`/documents/${job.items[0].documentId}`, { headers: g })).status, 404, 'no longer in the guest workspace');
});

test('supabase mode: signed direct upload, processing from storage, signed read URL', async () => {
  const sb = startFakeSupabase({ serviceKey: 'sb_secret_test_only' });
  process.env.SUPABASE_URL = sb.url;
  process.env.SUPABASE_SECRET_KEY = sb.serviceKey;
  resetStorageForTests();
  const g = guest();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    const health = await call('/health');
    assert.equal(health.body.fileStorage, 'supabase');

    const bytes = Buffer.concat([invoicePdf(), Buffer.alloc(5 * 1024 * 1024, 32)]);
    const sign = await call('/uploads/sign', json(g, { filename: 'big invoice.pdf', mimeType: 'application/pdf', size: 20 * 1024 * 1024 }));
    assert.equal(sign.status, 200, 'files above 4 MB are fine when they go straight to storage');
    assert.equal(sign.body.mode, 'supabase');
    assert.ok(!JSON.stringify(sign.body).includes(sb.serviceKey));
    const small = await call('/uploads/sign', json(g, { filename: 'small.pdf', mimeType: 'application/pdf', size: 100 }));
    assert.equal(small.body.mode, 'supabase', 'signed upload is the default for small files too');
    assert.ok(sb.buckets.has('documents'), 'bucket created on first use');
    assert.equal((await call('/uploads/sign', json(g, { filename: 'huge.pdf', mimeType: 'application/pdf', size: 60 * 1024 * 1024 }))).status, 413);

    // The browser PUTs the bytes to the signed URL (no API involved).
    const put = await fetch(sign.body.uploadUrl, { method: 'PUT', headers: sign.body.headers, body: bytes });
    assert.equal(put.status, 200);

    const created = await call('/jobs', json(g, { items: [{ path: sign.body.path, filename: 'big invoice.pdf', mimeType: 'application/pdf', size: bytes.length }] }));
    const job = await waitForJob(g, created.body.job.id);
    assert.equal(job.status, 'done', JSON.stringify(job));

    const fileUrl = await call(`/documents/${job.items[0].documentId}/file-url`, { headers: g });
    assert.equal(fileUrl.body.external, true);
    const file = await fetch(fileUrl.body.url);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(bytes));

    // Deleting the document deletes the stored original.
    assert.equal(sb.objects.size, 1);
    await call(`/documents/${job.items[0].documentId}`, { method: 'DELETE', headers: g });
    assert.equal(sb.objects.size, 0);
  } finally {
    setGeminiClient(null);
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.SUPABASE_SECRET_KEY = '';
    resetStorageForTests();
    sb.close();
  }
});


test('large PDFs checkpoint one page chunk per request and preserve original citations', async () => {
  const g = guest();
  const pages = Array.from({ length: 11 }, (_, i) => [
    'TAX INVOICE - long document', `Page ${i + 1} reference ${Math.random()}`,
    'Seller: Example Traders Pvt Ltd', 'Total: Rs. 1,180.00',
  ]);
  const up = await directUpload(g, makePdf(pages), 'long.pdf');
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'long.pdf', mimeType: 'application/pdf' }] }));
  const id = created.body.job.id;
  const itemId = created.body.job.items[0].id;
  let calls = 0;
  setGeminiClient({ models: { async generateContent() {
    calls++;
    return { text: JSON.stringify({ ...invoice, entities: [{ type: 'ORG', value: `Chunk ${calls}`, page: 1 }] }) };
  } } });
  try {
    for (let i = 0; i < 3; i++) {
      const response = await call(`/jobs/${id}/items/${itemId}/process`, { method: 'POST', headers: g });
      assert.equal(response.status, 200);
      assert.equal(calls, i + 1, 'only one chunk per request');
      assert.equal(response.body.job.items[0].status, i < 2 ? 'queued' : 'done');
      const info = response.body.job.items[0];
      assert.equal(info.pageProgress.pageCount, 11);
      assert.equal(info.pageProgress.chunkCount, 3);
      assert.equal(info.pageProgress.chunkIndex, i + 1);
      assert.equal(info.pageProgress.pageStart, i * 5 + 1);
      assert.equal(info.pageProgress.pageEnd, Math.min((i + 1) * 5, 11));
      assert.equal(info.pageProgress.pagesCompleted, Math.min((i + 1) * 5, 11));
      assert.ok(info.stageStartedAt, 'publish when the current stage began');
      assert.ok(!JSON.stringify(response.body).includes('rawTextByPage'), 'checkpoint stays server-side');
    }
    const job = (await call(`/jobs/${id}`, { headers: g })).body.job;
    const doc = (await call(`/documents/${job.items[0].documentId}`, { headers: g })).body;
    assert.equal(doc.pageCount, 11);
    assert.deepEqual(doc.entities.filter(e => e.value.startsWith('Chunk')).map(e => e.page), [1, 6, 11]);
    assert.equal((await call('/documents', { headers: g })).body.documents.length, 1, 'chunks do not create separate documents');
    await call(`/jobs/${id}/items/${itemId}/process`, { method: 'POST', headers: g });
    assert.equal(calls, 3, 'completed items are idempotent');
    const repeated = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'long.pdf', mimeType: 'application/pdf' }] }));
    const cached = await waitForJob(g, repeated.body.job.id);
    assert.equal(cached.items[0].cached, true);
    assert.equal(calls, 3, 'full-file cache is reused for chunked PDFs');
  } finally { setGeminiClient(null); }
});

test('scanned PDF chunks send only their pages to OCR and duplicate requests share a lease', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const g = guest();
  const up = await directUpload(g, makePdf(Array.from({ length: 6 }, () => [])), 'scanned-long.pdf');
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'scanned-long.pdf', mimeType: 'application/pdf' }] }));
  const id = created.body.job.id;
  const itemId = created.body.job.items[0].id;
  const counts = [];
  setGeminiClient({ models: { async generateContent(req) {
    const part = req.contents[0].parts.find(p => p.inlineData);
    counts.push((await PDFDocument.load(Buffer.from(part.inlineData.data, 'base64'))).getPageCount());
    await new Promise(r => setTimeout(r, 100));
    return { text: JSON.stringify(invoice) };
  } } });
  try {
    await Promise.all([1, 2].map(() => call(`/jobs/${id}/items/${itemId}/process`, { method: 'POST', headers: g })));
    assert.deepEqual(counts, [5]);
    const job = await waitForJob(g, id);
    assert.equal(job.status, 'done');
    assert.deepEqual(counts, [5, 1]);
    const doc = (await call(`/documents/${job.items[0].documentId}`, { headers: g })).body;
    assert.equal(doc.pageCount, 6);
    assert.equal(doc.ocrUsed, true);
  } finally { setGeminiClient(null); }
});

test('an OCR outage retries the uploaded PDF without losing its completed page checkpoint', async () => {
  const g = guest();
  // A short unique marker keeps this scan separate from the preceding test's
  // cached blank PDF while remaining below the usable text-layer threshold.
  const up = await directUpload(g, makePdf(Array.from({ length: 6 }, () => [`retry ${Math.random()}`])), 'retry-scanned.pdf');
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'retry-scanned.pdf', mimeType: 'application/pdf' }] }));
  const processPath = `/jobs/${created.body.job.id}/items/${created.body.job.items[0].id}/process`;
  try {
    setGeminiClient(fakeGemini([{ json: invoice }]));
    const firstChunk = await call(processPath, { method: 'POST', headers: g });
    assert.equal(firstChunk.body.job.items[0].status, 'queued');

    setGeminiClient(fakeGemini([]));
    const outage = await call(processPath, { method: 'POST', headers: g });
    assert.equal(outage.body.job.items[0].status, 'queued');
    assert.equal(outage.body.job.items[0].stage, 'retrying');
    assert.equal(outage.body.job.items[0].retryStage, 'extracting');
    assert.ok(outage.body.job.items[0].lastError);
    assert.equal(outage.body.job.items[0].pageProgress.pagesCompleted, 5, 'keep completed-page progress during a retry');
    assert.ok(!outage.body.job.items[0].error, 'a recoverable outage does not fail the upload');

    setGeminiClient(fakeGemini([{ json: { ...invoice, entities: [{ type: 'ORG', value: 'Recovered page', page: 1 }] } }]));
    const recovered = await call(processPath, { method: 'POST', headers: g });
    assert.equal(recovered.body.job.items[0].status, 'done');
    const doc = await call(`/documents/${recovered.body.job.items[0].documentId}`, { headers: g });
    assert.equal(doc.body.pageCount, 6);
    assert.equal(doc.body.entities.find(e => e.value === 'Recovered page').page, 6, 'only the unfinished page is retried');
    assert.equal((await call('/documents', { headers: g })).body.documents.length, 1);
  } finally { setGeminiClient(null); }
});

test('invalid AI credentials are reported accurately and do not repeatedly process the file', async () => {
  const g = guest();
  const up = await directUpload(g, makePdf([[]]), 'auth-scan.pdf');
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'auth-scan.pdf', mimeType: 'application/pdf' }] }));
  const fake = fakeGemini([{ error: { status: 403, message: 'PERMISSION_DENIED' } }]);
  setGeminiClient(fake);
  try {
    const result = await call(`/jobs/${created.body.job.id}/items/${created.body.job.items[0].id}/process`, { method: 'POST', headers: g });
    assert.equal(result.body.job.items[0].status, 'failed');
    assert.equal(result.body.job.items[0].errorStage, 'extracting');
    assert.match(result.body.job.items[0].error, /credentials.*rejected/);
    assert.equal(fake.calls.length, 1);
  } finally { setGeminiClient(null); }
});

test('a temporary storage download outage retries the same stored object', async t => {
  const sb = startFakeSupabase({ serviceKey: 'sb_secret_retry_test' });
  process.env.SUPABASE_URL = sb.url;
  process.env.SUPABASE_SECRET_KEY = sb.serviceKey;
  resetStorageForTests();
  const g = guest();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    const bytes = invoicePdf();
    const sign = await call('/uploads/sign', json(g, { filename: 'retry-download.pdf', mimeType: 'application/pdf', size: bytes.length }));
    await fetch(sign.body.uploadUrl, { method: 'PUT', headers: sign.body.headers, body: bytes });
    const created = await call('/jobs', json(g, { items: [{ path: sign.body.path, filename: 'retry-download.pdf', mimeType: 'application/pdf' }] }));
    let downloads = 0;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      if (String(url).startsWith(`${sb.url}/storage/v1/object/documents/`) && init?.method === 'GET' && ++downloads <= 3) {
        return Promise.resolve(new Response('temporary outage', { status: 503 }));
      }
      return originalFetch(url, init);
    });
    const processPath = `/jobs/${created.body.job.id}/items/${created.body.job.items[0].id}/process`;
    const outage = await call(processPath, { method: 'POST', headers: g });
    assert.equal(outage.body.job.items[0].status, 'queued');
    assert.equal(outage.body.job.items[0].stage, 'retrying');
    assert.equal(sb.objects.size, 1, 'keep the original for the retry');
    const recovered = await call(processPath, { method: 'POST', headers: g });
    assert.equal(recovered.body.job.items[0].status, 'done');
    assert.equal(downloads, 4);
    assert.equal(sb.objects.size, 1, 'the retry does not upload a duplicate');
  } finally {
    setGeminiClient(null);
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SECRET_KEY = '';
    resetStorageForTests();
    sb.close();
  }
});

test('the API upload relay reuses an owned signed target and respects the Vercel body limit', async () => {
  const sb = startFakeSupabase({ serviceKey: 'sb_secret_relay_test' });
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '';
  process.env.SUPABASE_URL = sb.url;
  process.env.SUPABASE_SECRET_KEY = sb.serviceKey;
  resetStorageForTests();
  const g = guest();
  const relay = async (headers, bytes, path) => {
    const form = new FormData();
    form.append('path', path);
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'relay.pdf');
    return call('/uploads', { method: 'POST', headers, body: form });
  };
  try {
    const bytes = Buffer.concat([invoicePdf(), Buffer.alloc(5 * 1024 * 1024, 32)]);
    process.env.VERCEL = '1';
    const sign = await call('/uploads/sign', json(g, { filename: 'relay.pdf', mimeType: 'application/pdf', size: bytes.length }));
    process.env.VERCEL = '';
    const local = await call('/uploads/sign', json(g, { filename: 'relay.pdf', mimeType: 'application/pdf', size: bytes.length }));
    assert.equal(local.body.mode, 'direct', 'avoid the browser DNS hop locally');
    assert.equal(local.body.maxBytes, 50 * 1024 * 1024);
    assert.equal(maxDirectUploadBytes(), local.body.maxBytes);
    // Simulate a signed upload whose successful response never reached the browser.
    await fetch(sign.body.uploadUrl, { method: 'PUT', headers: sign.body.headers, body: bytes });
    const fallback = await relay(g, bytes, sign.body.path);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.path, sign.body.path);
    assert.equal(fallback.body.driver, 'supabase');
    assert.equal(sb.objects.size, 1, 'reuse the same object instead of storing a duplicate');
    assert.deepEqual(sb.objects.get(`documents/${sign.body.path}`).data, bytes);
    assert.equal((await relay(guest(), bytes, sign.body.path)).status, 403, 'another owner cannot overwrite the target');
    assert.equal((await relay(g, bytes, `${sign.body.path}/../../other`)).status, 403);

    process.env.VERCEL = '1';
    const production = await call('/uploads/sign', json(g, { filename: 'relay.pdf', mimeType: 'application/pdf', size: bytes.length }));
    assert.equal(production.body.maxBytes, 50 * 1024 * 1024, 'direct-to-storage still accepts large files');
    assert.equal(production.body.directMaxBytes, 4 * 1024 * 1024, 'the API relay observes the serverless body limit');
    const tooLarge = await relay(g, bytes, sign.body.path);
    assert.equal(tooLarge.status, 413);
    assert.match(tooLarge.body.error, /4 MB/);
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SECRET_KEY = '';
    resetStorageForTests();
    sb.close();
  }
});

test('local uploads accept 50 MB without Supabase, including privacy mode', async () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '';
  resetStorageForTests();
  try {
    for (const mode of ['deep', 'privacy']) {
      const headers = { ...guest(), 'x-processing-mode': mode };
      const health = await call('/health', { headers });
      assert.equal(health.body.uploadLimitMb, 50);
      const maxBytes = 50 * 1024 * 1024;
      const bytes = Buffer.concat([invoicePdf(), Buffer.alloc(maxBytes, 32)]).subarray(0, maxBytes);
      const target = await call('/uploads/sign', json(headers, { filename: 'large.pdf', mimeType: 'application/pdf', size: bytes.length }));
      assert.equal(target.status, 200);
      assert.equal(target.body.mode, 'direct');
      assert.equal(target.body.maxBytes, maxBytes);
      const uploaded = await directUpload(headers, bytes, 'large.pdf');
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
      assert.equal(uploaded.body.size, maxBytes);
      const oversized = await call('/uploads/sign', json(headers, { filename: 'huge.pdf', mimeType: 'application/pdf', size: maxBytes + 1 }));
      assert.equal(oversized.status, 413);
      assert.match(oversized.body.error, /50 MB/);
      const rejected = await directUpload(headers, Buffer.concat([bytes, Buffer.from(' ')]), 'huge.pdf');
      assert.equal(rejected.status, 413);
      assert.match(rejected.body.error, /50 MB/);
    }
    process.env.VERCEL = '1';
    const deployed = await call('/uploads/sign', json(guest(), { filename: 'large.pdf', mimeType: 'application/pdf', size: 5 * 1024 * 1024 }));
    assert.equal(deployed.status, 413, 'Vercel still needs direct-to-storage for large files');
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    resetStorageForTests();
  }
});
