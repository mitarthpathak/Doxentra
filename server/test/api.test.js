import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run without external services: no database, no AI key.
process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1'; // don't start listening on import

const { default: app } = await import('../index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const post = (path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const samplePdf = readFileSync(new URL('./fixtures/sample.pdf', import.meta.url));

test('health reports memory storage and missing AI key', async () => {
  const r = await (await fetch(base + '/health')).json();
  assert.equal(r.status, 'online');
  assert.equal(r.mongodb, 'not-configured');
  assert.match(r.ai, /missing/);
});

test('signup, login, me and history access control', async () => {
  const email = `t${Date.now()}@example.com`;
  let r = await post('/auth/signup', { email, password: 'secret12', phone: '1', age: 20 });
  assert.equal(r.status, 201);
  const { token, user } = await r.json();
  assert.equal(user.email, email);
  assert.equal(user.passwordHash, undefined);

  assert.equal((await post('/auth/signup', { email, password: 'secret12', phone: '1', age: 20 })).status, 409);
  assert.equal((await post('/auth/login', { email, password: 'wrong123' })).status, 401);
  assert.equal((await post('/auth/login', { email: email.toUpperCase(), password: 'secret12' })).status, 200);

  assert.equal((await fetch(base + '/auth/me', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(base + '/auth/me', { headers: { authorization: `Bearer ${token}x` } })).status, 401);
  assert.equal((await fetch(base + '/graphs')).status, 401);
});

test('signup validates input', async () => {
  assert.equal((await post('/auth/signup', { email: 'bad', password: 'secret12', phone: '1', age: 20 })).status, 400);
  assert.equal((await post('/auth/signup', { email: 'a@b.co', password: '123', phone: '1', age: 20 })).status, 400);
  assert.equal((await post('/auth/signup', { email: 'a@b.co', password: 'secret12', phone: '1', age: 0 })).status, 400);
});

test('upload rejects non-PDF files', async () => {
  const fd = new FormData();
  fd.append('pdf', new Blob(['hello']), 'notes.txt');
  const r = await fetch(base + '/upload', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
});

test('upload falls back to a keyword map and saves it to history', async () => {
  const email = `u${Date.now()}@example.com`;
  const { token } = await (await post('/auth/signup', { email, password: 'secret12', phone: '1', age: 20 })).json();
  const fd = new FormData();
  fd.append('pdf', new Blob([samplePdf], { type: 'application/pdf' }), 'bio.pdf');
  const r = await fetch(base + '/upload', { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}` } });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.fallbackUsed, true);
  assert.ok(data.graph.nodes.length > 0);
  assert.ok(data.warning);

  const hist = await (await fetch(base + '/graphs', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(hist.graphs.length, 1);
  assert.equal(hist.graphs[0].filename, 'bio.pdf');

  const del = await fetch(`${base}/graphs/${hist.graphs[0]._id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(del.status, 200);
});

test('upload accepts images but needs the AI for OCR', async () => {
  const { makePng } = await import('./helpers/files.js');
  const fd = new FormData();
  fd.append('pdf', new Blob([makePng()], { type: 'image/png' }), 'scan.png');
  const r = await fetch(base + '/upload', { method: 'POST', body: fd });
  const data = await r.json();
  assert.equal(r.status, 422);
  assert.match(data.error, /image needs OCR.*not configured/);
});

test('upload rejects fake images, HEIC photos and oversized files', async () => {
  const { HEIC_HEADER } = await import('./helpers/files.js');
  const send = async (bytes, name, type) => {
    const fd = new FormData();
    fd.append('pdf', new Blob([bytes], { type }), name);
    const r = await fetch(base + '/upload', { method: 'POST', body: fd });
    return { status: r.status, error: (await r.json()).error };
  };
  let r = await send(Buffer.from('definitely not a png'), 'fake.png', 'image/png');
  assert.equal(r.status, 400);
  assert.match(r.error, /not a valid image/);

  r = await send(HEIC_HEADER, 'IMG_0001.HEIC', 'image/heic');
  assert.equal(r.status, 400);
  assert.match(r.error, /HEIC/);

  r = await send(Buffer.alloc(4 * 1024 * 1024 + 10, 0x20), 'big.pdf', 'application/pdf');
  assert.equal(r.status, 413);
  assert.match(r.error, /4 MB/);
});
