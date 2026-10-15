import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { normalizeExtraction } from '../server/lib/extract.js';
import { crosscheckExtraction } from '../server/lib/ocr/crosscheck.js';
import { ocrConfig } from '../server/lib/ocr/config.js';
import { finalizeExtraction } from '../server/lib/pipeline.js';
import { reviewField } from '../server/lib/review.js';
import { toDocumentResponse } from '../server/lib/documentView.js';

const input = { file: { data: Buffer.from('mock image'), mimeType: 'image/png' }, pageCount: 1, ocrUsed: true };
const raw = normalizeExtraction({ docType: 'invoice', fields: [{ key: 'total_amount', value: 'INR 500', page: 1, confidence: 0.99, sourceQuote: 'Total: INR 500' }] });
const extraction = await crosscheckExtraction(raw, input, { config: { ...ocrConfig({}), reprocess: false },
  dependencies: { runOcrEngines: async () => ['500', '508'].map((value, i) => ({ engine: i ? 'paddle' : 'tesseract', status: 'ok', text: `Total: INR ${value}`,
    words: [], lines: [{ text: `Total: INR ${value}`, confidence: 0.99, box: [100, 100, 200, 600] }] })) } });
let stored = { _id: 'ocr-ui-document', filename: 'invoice.png', processingMode: 'privacy',
  extraction: { ...finalizeExtraction(extraction, { textByPage: ['Total: INR 500'], ocrUsed: true }), rawTextByPage: ['Total: INR 500'], pageCount: 1, ocrUsed: true }, audit: [] };
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { createCanvas } = createRequire(new URL('../server/package.json', import.meta.url))('@napi-rs/canvas');
const sourceCanvas = createCanvas(1000, 500);
const sourceContext = sourceCanvas.getContext('2d');
sourceContext.fillStyle = '#fff'; sourceContext.fillRect(0, 0, 1000, 500);
sourceContext.fillStyle = '#000'; sourceContext.font = '36px Arial';
sourceContext.fillText('TAX INVOICE', 50, 40); sourceContext.fillText('Total: INR 500', 120, 90);
const sourceImage = sourceCanvas.toBuffer('image/png');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DOXENTRA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('doxentra_processing_mode', 'privacy'));
  await page.route('**/api/crosscheck?**', r => r.fulfill({ json: { issues: [] } }));
  await page.route('**/api/documents/*/twin', r => r.fulfill({ json: { twin: null } }));
  await page.route('**/api/documents/*/fields/*', async route => {
    const result = reviewField(stored.extraction, 'total_amount', route.request().postDataJSON(), { by: 'Reviewer' });
    stored = { ...stored, extraction: result.extraction, audit: [...stored.audit, result.audit] };
    await route.fulfill({ json: toDocumentResponse(stored, { auditEntry: result.audit }) });
  });
  const mount = route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/fonts/fonts.css"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    const {DocumentScreen}=await import('/src/components/DocumentScreen.tsx');
    function App(){const [doc,setDoc]=React.useState(${JSON.stringify(toDocumentResponse(stored))});const [selected,setSelected]=React.useState('total_amount');return React.createElement(DocumentScreen,{doc,recentDocs:[doc],selectedFieldKey:selected,onSelectField:setSelected,onSelectDoc:setDoc,onUploadClick:()=>{},onExport:async()=>{},onBuildConceptMap:async()=>{},onAsk:()=>{},onDocumentChange:setDoc});}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  </script></body></html>` });
  await page.route('**/ocr-ui-check', mount);
  await page.goto(`${process.env.DOXENTRA_UI_URL || 'http://localhost:5173'}/ocr-ui-check`);
  await page.getByTestId('ocr-review-queue').getByText('OCR review · 1 pending').waitFor();
  await page.getByTestId('ocr-candidates').getByText('INR 508', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('source-panel').getByText('Value withheld pending OCR review').count(), 1);
  assert.equal(await page.getByTestId('review-confirm').count(), 0);
  await page.getByTestId('ocr-candidates').getByRole('button', { name: 'Review this candidate' }).last().click();
  assert.equal(await page.getByTestId('review-value').inputValue(), 'INR 508');
  await page.getByTestId('review-save').click();
  await page.getByTestId('ocr-review-queue').getByText('OCR review · 0 pending').waitFor();
  await page.getByTestId('field-review-status').getByText(/Corrected/).waitFor();
  await page.getByTestId('review-reset').click();
  await page.getByTestId('ocr-review-queue').getByText('OCR review · 1 pending').waitFor();
  await page.setViewportSize({ width: 375, height: 800 });
  assert.equal(await page.getByTestId('document-screen').evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.deepEqual(errors, []);
  assert.equal(await page.getByTestId('source-crop').count(), 0);
  // Original images are available in deep mode; the crop uses source pixels,
  // independently of candidate text, and must also fit a narrow viewport.
  stored = { ...stored, processingMode: 'deep', mimeType: 'image/png', file: { path: 'mock-original.png' } };
  const preview = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  preview.on('pageerror', e => errors.push(e.message));
  await preview.route('**/api/crosscheck?**', r => r.fulfill({ json: { issues: [] } }));
  await preview.route('**/api/documents/*/twin', r => r.fulfill({ json: { twin: null } }));
  await preview.route('**/api/documents/*/file-url', r => r.fulfill({ json: { url: '/ocr-original.png', external: false, mimeType: 'image/png' } }));
  await preview.route('**/ocr-original.png', r => r.fulfill({ contentType: 'image/png', body: sourceImage }));
  await preview.route('**/ocr-ui-check', mount);
  await preview.goto(`${process.env.DOXENTRA_UI_URL || 'http://localhost:5173'}/ocr-ui-check`);
  await preview.locator('[data-testid="source-crop"][data-ready="true"]').waitFor();
  const crop = preview.getByTestId('source-crop').locator('canvas');
  assert.ok(await crop.evaluate(c => c.width > 0 && c.height > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((pixel, i) => i % 4 !== 3 && pixel < 200)));
  await preview.getByTestId('ocr-candidates').getByRole('button', { name: 'Review this candidate' }).last().click();
  assert.equal(await preview.getByTestId('review-value').inputValue(), 'INR 508');
  await preview.getByRole('button', { name: 'View full page' }).click();
  await preview.getByTestId('source-highlight').waitFor({ state: 'visible' });
  await preview.getByRole('button', { name: 'Hide full page' }).click();
  await preview.getByTestId('source-crop').scrollIntoViewIfNeeded();
  await mkdir('.playwright-mcp', { recursive: true });
  await preview.screenshot({ path: '.playwright-mcp/ocr-review-crop.png', fullPage: true });
  await preview.setViewportSize({ width: 375, height: 800 });
  assert.equal(await preview.getByTestId('document-screen').evaluate(el => el.scrollWidth > el.clientWidth), false);
  const refreshed = toDocumentResponse({ ...stored, _id: 'ocr-reread-document', extraction: {
    ...finalizeExtraction(raw, { textByPage: ['Total: INR 500'], ocrUsed: true }), pageCount: 1, ocrUsed: true,
  } });
  await preview.route('**/api/documents/ocr-ui-document/reprocess', r => r.fulfill({ status: 202, json: { job: { id: 'ocr-reread-job' } } }));
  await preview.route('**/api/jobs/ocr-reread-job', r => r.fulfill({ json: { job: { id: 'ocr-reread-job', status: 'done', items: [{ documentId: refreshed.id }] } } }));
  await preview.route('**/api/documents/ocr-reread-document', r => r.fulfill({ json: refreshed }));
  await preview.getByTestId('rerun-ocr').click();
  await preview.getByTestId('fields-table').getByText('INR 500', { exact: true }).waitFor();
  assert.equal(await preview.getByTestId('ocr-review-queue').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: OCR review queue, retained candidates, correction, audit/reset, original source crop, privacy isolation, mobile layout, re-run OCR recovery.');
} finally { await browser.close(); }
