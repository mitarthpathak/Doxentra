import test from 'node:test';
import assert from 'node:assert/strict';
import { generateStructured, setGeminiClient } from '../lib/ai.js';
import { storageRequest } from '../lib/supabase.js';

const generate = () => generateStructured({
  parts: [{ text: 'Read this document' }],
  schema: { type: 'object', properties: { title: { type: 'string' } } },
  deadline: Date.now() + 48_000,
  parse: JSON.parse,
});
const answer = { text: '{"title":"Recovered"}' };

test('extraction tries Flash-Lite first and aborts a stalled attempt after 15 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const calls = [];
  setGeminiClient({ models: { generateContent(req) {
    calls.push({ model: req.model, started: Date.now() });
    if (calls.length > 1) return Promise.resolve(answer);
    return new Promise((_resolve, reject) => req.config.abortSignal.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    }, { once: true }));
  } } });
  try {
    const pending = generateStructured({ parts: [], schema: {}, deadline: Date.now() + 25_000, parse: JSON.parse, tag: 'Extract' });
    assert.equal(calls[0].model, 'gemini-3.5-flash-lite', 'pin the current fast model instead of the moving latest alias');
    t.mock.timers.tick(15_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].started, 115_000);
    assert.equal((await pending).title, 'Recovered');
  } finally { setGeminiClient(null); t.mock.timers.reset(); }
});

test('a model with an exhausted daily quota stays skipped beyond the old one-minute cooldown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const calls = [];
  setGeminiClient({ models: { async generateContent(req) {
    calls.push(req.model);
    if (calls.length === 1) throw Object.assign(new Error('{"error":{"details":[{"retryDelay":"41463s"}]}}'), { status: 429 });
    return answer;
  } } });
  const request = () => generateStructured({ parts: [], schema: {}, deadline: Date.now() + 25_000, parse: JSON.parse, tag: 'Extract' });
  try {
    await request();
    t.mock.timers.tick(61_000);
    await request();
    assert.match(calls[0], /flash-lite/);
    assert.notEqual(calls[1], calls[0]);
    assert.equal(calls[2], calls[1], 'do not retry a model before its reported quota reset');
  } finally { setGeminiClient(null); t.mock.timers.reset(); }
});

test('extraction tries each model only once per processing request', async () => {
  let calls = 0;
  setGeminiClient({ models: { async generateContent() {
    calls++;
    throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
  } } });
  try {
    await assert.rejects(generateStructured({ parts: [], schema: {}, deadline: Date.now() + 25_000, parse: JSON.parse, tag: 'Extract' }), e => e.status === 503);
    assert.equal(calls, 2, 'do not repeat the model chain before the job retry');
  } finally { setGeminiClient(null); }
});

test('an SDK abort with code 20 switches to the backup model', async () => {
  const calls = [];
  setGeminiClient({ models: { async generateContent(req) {
    calls.push(req);
    if (calls.length === 1) throw Object.assign(new Error('This operation was aborted'), { code: 20 });
    return answer;
  } } });
  try {
    assert.equal((await generate()).title, 'Recovered');
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].model, calls[1].model);
  } finally { setGeminiClient(null); }
});

test('a hung primary leaves at least 20 seconds for the backup within the processing deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const calls = [];
  setGeminiClient({ models: { generateContent(req) {
    calls.push({ model: req.model, started: Date.now() });
    if (calls.length > 1) return Promise.resolve(answer);
    return new Promise((_resolve, reject) => req.config.abortSignal.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    }, { once: true }));
  } } });
  try {
    const pending = generate();
    t.mock.timers.tick(28_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls.length, 2, 'the primary must be aborted before it consumes the backup budget');
    assert.ok(calls[1].started <= 128_000);
    assert.equal((await pending).title, 'Recovered');
  } finally {
    setGeminiClient(null);
    t.mock.timers.reset();
  }
});

test('latest Flash models use supported thinking levels instead of a zero thinking budget', async () => {
  const calls = [];
  setGeminiClient({ models: { async generateContent(req) {
    calls.push(req);
    if (calls.length === 1) throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
    return answer;
  } } });
  try {
    await generate();
    assert.deepEqual(calls[0].config.thinkingConfig, { thinkingLevel: 'low' });
    assert.deepEqual(calls[1].config.thinkingConfig, { thinkingLevel: 'minimal' });
  } finally { setGeminiClient(null); }
});

test('storage downloads retry temporary failures, including a timeout while reading the response body', async t => {
  process.env.SUPABASE_URL = 'https://storage.example.test';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return new Response('temporarily unavailable', { status: 503 });
    if (calls === 2) return {
      ok: true,
      arrayBuffer: async () => { throw new DOMException('Download timed out', 'TimeoutError'); },
    };
    return new Response('original document bytes');
  });
  try {
    assert.equal((await storageRequest('GET', '/object/documents/test.pdf', { raw: true })).toString(), 'original document bytes');
    assert.equal(calls, 3);
  } finally {
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SECRET_KEY = '';
  }
});

test('storage does not retry permission failures or replay an upload', async t => {
  process.env.SUPABASE_URL = 'https://storage.example.test';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    calls++;
    return new Response('rejected', { status: method === 'GET' ? 401 : 503 });
  });
  try {
    await assert.rejects(storageRequest('GET', '/object/documents/test.pdf'), e => e.status === 401);
    await assert.rejects(storageRequest('POST', '/object/documents/test.pdf', { body: Buffer.from('pdf') }), e => e.status === 503);
    assert.equal(calls, 2);
  } finally {
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SECRET_KEY = '';
  }
});
