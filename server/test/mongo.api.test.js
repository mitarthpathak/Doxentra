import test from 'node:test';
import { runSearchSuite } from './helpers/searchSuite.js';

// MongoDB backend (text index search). Runs only when TEST_MONGO_URI points
// to a disposable database, e.g.
//   docker run -d -p 27017:27017 mongo:7
//   TEST_MONGO_URI=mongodb://localhost:27017/doxentra_test npm test
const uri = process.env.TEST_MONGO_URI;
if (!uri) {
  test('MongoDB backend (skipped: set TEST_MONGO_URI to run)', { skip: true }, () => {});
} else {
  process.env.MONGO_URI = uri;
  process.env.GEMINI_API_KEY = '';
  process.env.AUTH_SECRET = 'test-secret';
  process.env.VERCEL = '1';

  const { default: mongoose } = await import('mongoose');
  const { connectDB } = await import('../lib/db.js');
  const { default: GraphModel } = await import('../models/Graph.js');
  const { default: app } = await import('../index.js');
  const { setGeminiClient } = await import('../lib/ai.js');
  if (!(await connectDB())) throw new Error(`Could not connect to ${uri}`);
  await mongoose.connection.db.dropDatabase();
  await GraphModel.syncIndexes();

  const server = app.listen(0);
  test.after(async () => {
    server.close();
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  test('search API (MongoDB backend)', async t => {
    await t.test('the text index exists', async () => {
      const indexes = await GraphModel.collection.indexes();
      if (!indexes.some(i => i.name === 'document_search')) throw new Error('document_search index missing');
    });
    await runSearchSuite(t, { base: `http://127.0.0.1:${server.address().port}/api`, setGeminiClient });

    await t.test('legacy concept-map upload still saves to History', async () => {
      const { readFileSync } = await import('node:fs');
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const r = await fetch(base + '/auth/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `m${Date.now()}@example.com`, password: 'secret12', phone: '1', age: 20 }),
      });
      const auth = { authorization: `Bearer ${(await r.json()).token}` };
      const fd = new FormData();
      fd.append('pdf', new Blob([readFileSync(new URL('./fixtures/sample.pdf', import.meta.url))], { type: 'application/pdf' }), 'bio.pdf');
      const up = await fetch(base + '/upload', { method: 'POST', body: fd, headers: auth });
      if (up.status !== 200) throw new Error(`upload ${up.status}`);
      const hist = await (await fetch(base + '/graphs', { headers: auth })).json();
      if (hist.graphs.length !== 1 || hist.graphs[0].filename !== 'bio.pdf') throw new Error('history');
      const docs = await (await fetch(base + '/documents', { headers: auth })).json();
      if (docs.documents.length !== 0) throw new Error('concept maps must not appear as documents');
    });
  });

  test('review and audit trail (MongoDB backend)', async () => {
    const assert = (await import('node:assert/strict')).default;
    const { readFileSync } = await import('node:fs');
    const { makePdf } = await import('./helpers/files.js');
    const { fakeGemini } = await import('./helpers/fakeGemini.js');
    const { updateDocument } = await import('../lib/db.js');
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const email = `rv${Date.now()}@example.com`;
    const r = await fetch(base + '/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'secret12', phone: '1', age: 20 }),
    });
    const { token, user } = await r.json();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const fd = new FormData();
    fd.append('files', new Blob([makePdf([['TAX INVOICE', 'Invoice No: INV-2024-0042', 'Total: Rs. 1,180.00']])], { type: 'application/pdf' }), 'inv.pdf');
    setGeminiClient(fakeGemini([{ json: JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url))) }]));
    let doc;
    try {
      doc = (await (await fetch(base + '/extract', { method: 'POST', body: fd, headers: { authorization: headers.authorization } })).json()).documents[0];
    } finally {
      setGeminiClient(null);
    }
    const patch = body => fetch(`${base}/documents/${doc.id}/fields/total_amount`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal((await patch({ action: 'correct', value: 'Rs. 1,280.00' })).status, 200);
    assert.equal((await patch({ action: 'reset' })).status, 200);
    const stored = await GraphModel.findById(doc.id).lean();
    assert.deepEqual(stored.audit.map(a => [a.action, a.by]), [['correct', email], ['reset', email]]);
    assert.equal(stored.extraction.fields.find(f => f.key === 'total_amount').value, 'Rs. 1,180.00');
    // Appends only on top of the trail the change was based on.
    const owner = { _id: new mongoose.Types.ObjectId(user.id), email };
    assert.equal(await updateDocument(doc.id, owner, { 'extraction.title': 'x' }, { audit: { action: 'confirm' }, auditLength: 1 }), null);
    assert.equal((await GraphModel.findById(doc.id).lean()).audit.length, 2);
  });
}
