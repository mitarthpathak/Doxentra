import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiKeyPool, configuredGeminiKeys, nextPacificMidnight } from '../lib/geminiPool.js';
import { generateStructured, setGeminiPool, setGeminiClient, visionModelList } from '../lib/ai.js';
import { analyzeGemini, mapConcurrent, verificationTargets } from '../lib/geminiPipeline.js';
import { normalizeExtraction } from '../lib/extract.js';
import { openPdfRenderer } from '../lib/pdfRender.js';
import { makePdf, makePng } from './helpers/files.js';
import { mergeConceptMaps } from '../lib/pdfChunks.js';
import { readFile } from 'node:fs/promises';

const raw = (fields = []) => ({ docType: 'other', docTypeConfidence: 0.99, title: 'Test', language: 'hi+en', summary: 'Test document.', fields, entities: [] });
const deadline = () => Date.now() + 48_000;
const pdfInput = pages => ({ pageCount: pages.length, pages, mode: 'text+file', unreliablePages: pages.map((p, i) => p ? null : i + 1).filter(Boolean), file: { data: makePdf(pages.map(p => [p])), mimeType: 'application/pdf' } });
const fakeRenderer = calls => async () => ({ render: async page => { calls.push(page); return { data: Buffer.from(`page-${page}`), mimeType: 'image/png' }; }, close: async () => {} });

test('Gemini keys are numerically ordered, legacy-compatible and deduplicated', () => {
  assert.deepEqual(configuredGeminiKeys({ GEMINI_API_KEY_2: 'b', GEMINI_API_KEY_10: 'c', GEMINI_API_KEY_1: ' a ', GEMINI_API_KEY: 'a' }), ['a', 'b', 'c']);
});

test('a single configured vision model still has a backup', () => {
  assert.deepEqual(visionModelList({ GEMINI_MODEL: 'gemini-3.5-flash-lite' }), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  assert.deepEqual(visionModelList({ GEMINI_VISION_MODEL: 'gemini-3.1-flash-lite' }), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
});

test('Gemini round robin switches immediately on 429 and cooldown is key/model scoped', async () => {
  const calls = [];
  let first = true;
  const pool = new GeminiKeyPool(['a', 'b'], { createClient: key => ({ models: { async generateContent(req) {
    calls.push([key, req.model, Date.now()]);
    if (key === 'a' && first) { first = false; throw Object.assign(new Error('{"retryDelay":"7200s"}'), { status: 429 }); }
    return { text: '{"ok":true}' };
  } } }) });
  setGeminiPool(pool);
  try {
    await generateStructured({ parts: [], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Extract' });
    assert.deepEqual(calls.map(c => c[0]), ['a', 'b']);
    assert.equal(calls[0][1], calls[1][1], 'same model, next key before model fallback');
    assert.ok(calls[1][2] - calls[0][2] < 100, 'no backoff before switching keys');
    assert.equal(pool.available(calls[0][1]).length, 1);
    assert.equal(pool.available('another-model').length, 2);
    await generateStructured({ parts: [], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Extract' });
    assert.equal(calls.at(-1)[0], 'b', 'exhausted key is skipped');
  } finally { setGeminiPool(null); }
  const rotating = new GeminiKeyPool(['a', 'b'], { createClient: key => ({ key }) });
  assert.deepEqual(Array.from({ length: 4 }, () => rotating.take('model').client.key), ['a', 'b', 'a', 'b']);
});

test('brief Stage 1 overload retries the fast model once before slower aliases', async () => {
  const models = [];
  setGeminiClient({ models: { async generateContent(req) {
    models.push(req.model);
    if (models.length === 1) throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
    return { text: '{"ok":true}' };
  } } });
  try {
    const response = await generateStructured({ parts: [], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Gemini.Stage1' });
    assert.equal(response.ok, true);
    assert.equal(models.length, 2); assert.equal(models[0], models[1]);
  } finally { setGeminiClient(null); }
});

test('Stage 1 tries the backup vision model after a timeout and a 503', async () => {
  const calls = [];
  let primary;
  const pool = new GeminiKeyPool(['first', 'second'], { createClient: key => ({ models: { async generateContent(req) {
    primary ||= req.model;
    calls.push([key, req.model]);
    if (req.model === primary && key === 'first') throw new DOMException('Aborted', 'AbortError');
    if (req.model === primary && key === 'second') throw Object.assign(new Error('overloaded'), { status: 503 });
    return { text: '{"ok":true}' };
  } } }) });
  setGeminiPool(pool);
  try {
    const response = await generateStructured({ parts: [], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Gemini.Stage1' });
    assert.equal(response.ok, true);
    assert.deepEqual(calls.slice(0, 2).map(call => call[0]), ['first', 'second']);
    assert.equal(calls[0][1], calls[1][1]);
    assert.notEqual(calls.at(-1)[1], primary);
  } finally { setGeminiPool(null); }
});

test('a stalled vision key leaves a full useful window for the second key', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const calls = [];
  const pool = new GeminiKeyPool(['first', 'second'], { createClient: key => ({ models: { generateContent(req) {
    calls.push({ key, started: Date.now() });
    if (key === 'first') return new Promise((_resolve, reject) => req.config.abortSignal.addEventListener('abort',
      () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    return new Promise(resolve => setTimeout(() => resolve({ text: '{"ok":true}' }), 12_000));
  } } }) });
  setGeminiPool(pool);
  try {
    const pending = generateStructured({ parts: [], schema: {}, deadline: Date.now() + 30_000, parse: JSON.parse, tag: 'Gemini.Stage1', keySlot: 0 });
    t.mock.timers.tick(12_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(calls, [{ key: 'first', started: 100_000 }, { key: 'second', started: 112_000 }]);
    t.mock.timers.tick(12_000);
    assert.equal((await pending).ok, true);
  } finally { setGeminiPool(null); t.mock.timers.reset(); }
});

test('ordinary requests rotate evenly and rejected credentials fail over safely', async () => {
  const calls = [];
  let badCredential = false;
  const pool = new GeminiKeyPool(['first', 'second'], { createClient: key => ({ models: { async generateContent() {
    calls.push(key);
    if (badCredential && key === 'first') throw Object.assign(new Error('API_KEY_INVALID'), { status: 400 });
    return { text: '{"ok":true}' };
  } } }) });
  setGeminiPool(pool);
  const generate = () => generateStructured({ parts: [], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Gemini.Stage2' });
  try {
    for (let i = 0; i < 10; i++) await generate();
    assert.equal(calls.filter(k => k === 'first').length, 5);
    assert.equal(calls.filter(k => k === 'second').length, 5);
    badCredential = true;
    assert.equal((await generate()).ok, true);
    assert.equal(pool.entries[0].disabled, true);
    assert.equal(calls.at(-1), 'second');
  } finally { setGeminiPool(null); }
});

test('page key allocation survives out-of-order rendering and alternates two keys', async () => {
  const calls = [];
  const pool = new GeminiKeyPool(['first', 'second'], { createClient: key => ({ models: { async generateContent(req) {
    const image = req.contents[0].parts.find(p => p.inlineData);
    calls.push({ key, page: image ? Buffer.from(image.inlineData.data, 'base64').toString() : 'text' });
    return { text: image ? '{"text":"Visible page text","visibleFields":[]}' : '{"ok":true}' };
  } } }) });
  setGeminiPool(pool);
  try {
    await analyzeGemini(pdfInput(['', '', '']), { deadline: deadline(), dependencies: {
      openPdfRenderer: async () => ({ render: async page => {
        await new Promise(r => setTimeout(r, page === 1 ? 10 : page === 3 ? 5 : 0));
        return { data: Buffer.from(`page-${page}`), mimeType: 'image/png' };
      }, close: async () => {} }),
      extractDocument: async () => normalizeExtraction(raw()),
    } });
    assert.deepEqual(Object.fromEntries(calls.map(c => [c.page, c.key])), { 'page-2': 'second', 'page-3': 'first', 'page-1': 'first' });
    await generateStructured({ parts: [{ text: 'Reason over text' }], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Gemini.Stage2' });
    assert.equal(calls.at(-1).key, 'second', 'reasoning continues the pool rotation');
  } finally { setGeminiPool(null); }
});

test('all quota failures expose a cooldown and become eligible after reset', async () => {
  let now = 100_000;
  const pool = new GeminiKeyPool(['first', 'second'], { now: () => now, createClient: () => ({ models: { async generateContent() {
    throw Object.assign(new Error('{"retryDelay":"5s"}'), { status: 429 });
  } } }) });
  setGeminiPool(pool);
  try {
    await assert.rejects(generateStructured({ parts: [], schema: {}, deadline: deadline(), parse: JSON.parse, tag: 'Gemini.Stage3' }),
      error => error.code === 'AI_QUOTA_EXHAUSTED' && error.retryAt === 105_000);
    assert.equal(pool.available('gemini-3.5-flash-lite').length, 0);
    now += 5000;
    assert.equal(pool.available('gemini-3.5-flash-lite').length, 2);
  } finally { setGeminiPool(null); }
  assert.equal(nextPacificMidnight(Date.parse('2026-10-13T14:00:00Z')), Date.parse('2026-10-14T07:00:00Z'));
  assert.equal(nextPacificMidnight(Date.parse('2026-12-13T14:00:00Z')), Date.parse('2026-12-14T08:00:00Z'));
});

test('Stage 2 quota exhaustion defers full reasoning instead of returning a basic result', async () => {
  await assert.rejects(analyzeGemini(pdfInput(['Clean digital document with enough selectable text to bypass vision.']), {
    deadline: deadline(), dependencies: { extractDocument: async () => { throw Object.assign(new Error('quota exhausted'), { status: 429, retryAt: Date.now() + 5000 }); } },
  }), error => error.status === 429);
});

test('page worker concurrency is 3, ordered, and waits for workers after a failure', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([1, 2, 3, 4, 5], 3, async n => {
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 5)); active--; return n * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test('mixed multi-page PDF skips clean layers and routes every unreadable page to Gemini', async () => {
  const rendered = [], gemini = [];
  let received;
  const clean = 'A clean selectable paragraph with enough characters to skip OCR.';
  const result = await analyzeGemini(pdfInput([clean, '', '']), { deadline: deadline(), dependencies: {
    openPdfRenderer: fakeRenderer(rendered),
    geminiOcr: async (image, _deadline, index) => { gemini.push([image.data.toString(), index]); return { text: image.data.toString() === 'page-2' ? 'दूसरा पृष्ठ' : 'तीसरा पृष्ठ', visibleFields: [] }; },
    extractDocument: async (input, options) => { received = [input, options]; return normalizeExtraction(raw()); },
  } });
  assert.deepEqual(rendered, [2, 3]);
  assert.deepEqual(gemini, [['page-2', 0], ['page-3', 1]]);
  assert.equal(received[0].mode, 'text'); assert.equal(received[0].file, undefined);
  assert.match(received[0].text, /=== PAGE 3 ===\nतीसरा पृष्ठ/);
  assert.equal(received[1].includeConceptMap, true);
  assert.equal(result.pipeline.timings.textPages, 1);
  assert.deepEqual(result.pipeline.visionPageNumbers, [2, 3]);
});

test('clean Indian ID PDF pages skip vision; scans/images use Gemini with original page offsets', async () => {
  let gemini = 0;
  const indexes = [];
  const dependencies = { openPdfRenderer: fakeRenderer([]),
    geminiOcr: async (_image, _deadline, index) => { gemini++; indexes.push(index); return { text: 'आधार पहचान', visibleFields: [] }; },
    extractDocument: async () => normalizeExtraction(raw()) };
  await analyzeGemini(pdfInput(['AADHAAR Government of India with a clean selectable text layer.', 'Another clean selectable paragraph with sufficient text.', '']), { deadline: deadline(), dependencies });
  await analyzeGemini({ pages: [], pageCount: 1, file: { data: makePng(), mimeType: 'image/png' } }, { deadline: deadline(), dependencies });
  assert.equal(gemini, 2);
  await analyzeGemini(pdfInput(['']), { deadline: deadline(), pageOffset: 10, dependencies });
  assert.equal(gemini, 3);
  assert.deepEqual(indexes, [0, 0, 10]);
});

test('selective verification fixes only flagged page fields; Aadhaar checksum survives masking', async () => {
  const rendered = [], verified = [];
  const input = pdfInput(['', '', '']);
  const result = await analyzeGemini(input, { deadline: deadline(), filename: 'aadhaar.pdf', dependencies: {
    openPdfRenderer: fakeRenderer(rendered),
    geminiOcr: async () => ({ text: 'आधार संख्या 2345 6789 0125\nName: Asha Verma', visibleFields: [] }),
    extractDocument: async () => normalizeExtraction({ ...raw(), docType: 'identity_document', docSubtype: 'aadhaar', title: 'Aadhaar',
      fields: [{ key: 'document_name', value: 'Aadhaar', confidence: 0.99, page: 1, sourceQuote: 'आधार' },
        { key: 'id_number', value: '2345 6789 0125', confidence: 0.99, page: 2, sourceQuote: 'आधार संख्या 2345 6789 0125' },
        { key: 'holder_name', value: 'Asha Verma', confidence: 0.99, page: 1, sourceQuote: 'Name: Asha Verma' }] }, { pageCount: 3 }),
    verify: async req => {
      verified.push(req.parts[1].inlineData.data);
      return { fields: [{ key: 'id_number', value: '2345 6789 0125', confidence: 0.9, sourceQuote: 'आधार संख्या 2345 6789 0125' },
        { key: 'holder_name', value: 'Injected name', confidence: 1 }] };
    },
  } });
  assert.deepEqual(verified.map(s => Buffer.from(s, 'base64').toString()), ['page-2']);
  assert.equal(result.fields.find(f => f.key === 'holder_name').value, 'Asha Verma', 'unknown verification keys ignored');
  assert.equal(result.fields.find(f => f.key === 'id_number').value, 'XXXX XXXX 0125');
  assert.ok(result.pipeline.checksumIssues.some(i => i.rule === 'aadhaar.checksum'));
  assert.ok(!JSON.stringify(result).includes('2345 6789 0125'));
});

test('high-confidence digital pages never render or use vision', async () => {
  const result = normalizeExtraction(raw([{ key: 'reference_number', value: 'ABC-1234', confidence: 0.99, page: 1, sourceQuote: 'Reference: ABC-1234' }]));
  const input = pdfInput(['Reference: ABC-1234. A selectable document with sufficient clean text.']);
  const answer = await analyzeGemini(input, { deadline: deadline(), dependencies: {
    openPdfRenderer: async () => { throw new Error('should not render'); }, extractDocument: async () => result,
  } });
  assert.equal(answer.pipeline.timings.visionPages, 0);
  assert.equal(verificationTargets(result, input.pages).size, 0);
});

test('successful OCR survives a Stage 2 outage as an explicitly marked basic result', async () => {
  const answer = await analyzeGemini({ pages: [], pageCount: 1, file: { data: makePng(), mimeType: 'image/png' } }, {
    deadline: deadline(), dependencies: {
      geminiOcr: async () => ({ text: 'TAX INVOICE\nInvoice No: INV-42\nDate: 01/02/2024\nTotal: Rs. 590.00', visibleFields: [] }),
      extractDocument: async () => { throw Object.assign(new Error('UNAVAILABLE'), { status: 503 }); },
    },
  });
  assert.equal(answer.pipeline.fallback, true);
  assert.equal(answer.fields.find(f => f.key === 'invoice_number').value, 'INV-42');
  assert.ok(answer.pipeline.textByPage[0].includes('INV-42'));
});

test('early model masking does not hide a failed Verhoeff check from Stage 3', async () => {
  let verified = 0;
  const result = await analyzeGemini({ pageCount: 1, pages: [], file: { data: makePng(), mimeType: 'image/png' } }, {
    deadline: deadline(), dependencies: {
      geminiOcr: async () => ({ text: 'Aadhaar number: 2345 6789 0125', visibleFields: [] }),
      extractDocument: async () => normalizeExtraction({ ...raw(), docType: 'identity_document', docSubtype: 'aadhaar', title: 'Aadhaar',
        fields: [{ key: 'id_number', value: 'XXXX XXXX 0125', confidence: 0.99, page: 1 }] }),
      verify: async () => { verified++; return { fields: [{ key: 'id_number', value: '2345 6789 0125', confidence: 0.99 }] }; },
    },
  });
  assert.equal(verified, 1);
  assert.ok(result.pipeline.checksumIssues.some(i => i.rule === 'aadhaar.checksum'));
  assert.equal(result.fields.find(f => f.key === 'id_number').value, 'XXXX XXXX 0125');
});

test('PDF renderer produces different nonblank images for a printed and blank page', async () => {
  const pdf = await openPdfRenderer(makePdf([['Hello Doxentra'], []]));
  try {
    const a = await pdf.render(1), b = await pdf.render(2);
    assert.equal(a.mimeType, 'image/jpeg'); assert.ok(a.data.length > b.data.length);
    assert.notDeepEqual(a.data, b.data);
  } finally { await pdf.close(); }
});

test('PDF renderer handles an actual embedded raster scan with the same canvas runtime', async () => {
  const pdf = await openPdfRenderer(await readFile(new URL('../../samples/f-student-id-scanned.pdf', import.meta.url)));
  try {
    const image = await pdf.render(1);
    assert.ok(image.data.length > 100_000, 'embedded scanned page is rendered, not a blank canvas');
  } finally { await pdf.close(); }
});

test('chunk concept maps share one root and retain concepts for the existing quiz', () => {
  const graph = { nodes: [{ id: 'r', type: 'major', label: 'Root' }, { id: 'h', type: 'header', label: 'Header', parentId: 'r' }], edges: [{ source: 'r', target: 'h', label: 'contains' }] };
  const merged = mergeConceptMaps([{ graph, metadata: {} }, { graph, metadata: {} }]);
  assert.equal(merged.graph.nodes.filter(n => n.type === 'major').length, 1);
  assert.equal(new Set(merged.graph.nodes.map(n => n.id)).size, 3);
  assert.ok(merged.graph.edges.every(e => e.source === 'gemini-root'));
});

test.after(() => setGeminiClient(null));
