import test from 'node:test';
import assert from 'node:assert/strict';
import { readPageWithGroq } from '../lib/groqOcr.js';
import { analyzeGemini } from '../lib/geminiPipeline.js';
import { GeminiKeyPool } from '../lib/geminiPool.js';
import { setGeminiPool } from '../lib/ai.js';
import { normalizeExtraction } from '../lib/extract.js';
import { processDocument } from '../lib/processDocument.js';
import { toDocumentResponse } from '../lib/documentView.js';
import { makePng } from './helpers/files.js';

const image = { data: makePng(), mimeType: 'image/png' };
const input = { pages: [''], pageCount: 1, file: image };
const extracted = () => normalizeExtraction({ docType: 'other', docTypeConfidence: 0.9, title: 'Test',
  language: 'en', summary: 'Visible text.', fields: [], entities: [] });
const deadline = () => Date.now() + 48_000;

test('Groq receives a base64 image and JSON-only OCR request', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const text = await readPageWithGroq(image, 'Read the document', { deadline: deadline(), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(options.headers.authorization, 'Bearer test-key');
      assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"text":"Visible text","visibleFields":[]}' } }] }) };
    } });
    assert.match(text, /Visible text/);
  } finally { process.env.GROQ_API_KEY = ''; }
});

test('successful Gemini OCR never calls Groq', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const result = await analyzeGemini(input, { deadline: deadline(), dependencies: {
      geminiOcr: async () => ({ text: 'Visible text', visibleFields: [] }),
      groqOcr: async () => { throw new Error('Groq must stay idle'); },
      extractDocument: async () => extracted(),
    } });
    assert.equal(result.pipeline.groqOcrPages, 0);
  } finally { process.env.GROQ_API_KEY = ''; }
});

test('Gemini OCR quota failure uses Groq and returns a basic result if Gemini reasoning is also limited', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const stages = [];
  try {
    const result = await analyzeGemini(input, { deadline: deadline(), onStage: stage => { stages.push(stage); }, dependencies: {
      geminiOcr: async () => { throw Object.assign(new Error('quota'), { status: 429, code: 'AI_QUOTA_EXHAUSTED' }); },
      groqOcr: async () => '{"text":"TAX INVOICE\\nTotal: Rs. 590.00","visibleFields":[]}',
      extractDocument: async () => { throw Object.assign(new Error('quota'), { status: 429 }); },
    } });
    assert.equal(result.pipeline.groqOcrPages, 1);
    assert.equal(result.pipeline.geminiOcrQuotaReached, true);
    assert.equal(result.pipeline.fallback, true);
    assert.ok(result.ocrText[0].text.includes('TAX INVOICE'));
    assert.ok(stages.includes('reading_groq_quota'));
  } finally { process.env.GROQ_API_KEY = ''; }
});

test('completed Gemini OCR is retained as a basic result if reasoning hits quota', async () => {
  const result = await analyzeGemini(input, { deadline: deadline(), dependencies: {
    geminiOcr: async () => ({ text: 'TAX INVOICE\nTotal: Rs. 590.00', visibleFields: [] }),
    extractDocument: async () => { throw Object.assign(new Error('quota'), { status: 429 }); },
  } });
  assert.equal(result.pipeline.groqOcrPages, 0);
  assert.equal(result.pipeline.fallback, true);
  assert.match(result.ocrText[0].text, /TAX INVOICE/);
});

test('both OCR providers failing exposes a distinct retryable error', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  try {
    await assert.rejects(analyzeGemini(input, { deadline: deadline(), dependencies: {
      geminiOcr: async () => { throw Object.assign(new Error('quota'), { status: 429 }); },
      groqOcr: async () => { throw Object.assign(new Error('Groq busy'), { status: 503 }); },
    } }), error => error.code === 'OCR_PROVIDERS_FAILED' && error.retryable && error.groqStatus === 503);
  } finally { process.env.GROQ_API_KEY = ''; }
});

test('Gemini quota precheck still reaches Groq, while a ready backup Gemini model remains preferred', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const pool = new GeminiKeyPool(['test'], { createClient: () => ({ models: { async generateContent(req) {
    if (req.contents[0].parts.some(part => part.inlineData)) return { text: '{"text":"Gemini text","visibleFields":[]}' };
    return { text: '{}' };
  } } }) });
  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  try {
    for (const model of models) pool.entries[0].cooldowns.set(model, Date.now() + 60_000);
    setGeminiPool(pool);
    const result = await analyzeGemini(input, { deadline: deadline(), dependencies: {
      groqOcr: async () => '{"text":"Groq text","visibleFields":[]}',
      extractDocument: async () => extracted(),
    } });
    assert.equal(result.pipeline.groqOcrPages, 1);
    assert.equal(result.pipeline.geminiOcrQuotaReached, true);

    pool.entries[0].cooldowns.delete(models[1]);
    const preferred = await analyzeGemini(input, { deadline: deadline(), dependencies: {
      groqOcr: async () => { throw new Error('Groq must stay idle'); },
      extractDocument: async () => extracted(),
    } });
    assert.equal(preferred.pipeline.groqOcrPages, 0);
    assert.equal(preferred.ocrText[0].text, 'Gemini text');
  } finally { setGeminiPool(null); process.env.GROQ_API_KEY = ''; }
});

test('the document result retains its Groq quota notice when reopened', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(url, /^https:\/\/api\.groq\.com\//);
    return { ok: true, json: async () => ({ choices: [{ message: { content:
      '{"text":"TAX INVOICE\\nTotal: Rs. 590.00","visibleFields":[]}' } }] }) };
  };
  setGeminiPool(new GeminiKeyPool(['test'], { createClient: () => ({ models: { async generateContent() {
    throw Object.assign(new Error('quota'), { status: 429 });
  } } }) }));
  try {
    const result = await processDocument({ buffer: image.data, originalname: 'test-invoice.png', mimetype: 'image/png' },
      { deadline: deadline(), deferSave: true, pipeline: 'gemini' });
    assert.equal(result.success, true);
    assert.match(result.warning, /Gemini OCR limit reached\. Groq read the image/);
    assert.equal(result.doc.warning, result.warning);
    assert.equal(toDocumentResponse({ ...result.doc, _id: 'test-id' }).warning, result.warning);
  } finally { globalThis.fetch = originalFetch; setGeminiPool(null); process.env.GROQ_API_KEY = ''; }
});
