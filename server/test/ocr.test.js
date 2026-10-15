import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { normalizeExtraction } from '../lib/extract.js';
import { ocrConfig, ocrConfigHash } from '../lib/ocr/config.js';
import { runOcrEngines } from '../lib/ocr/runner.js';
import { crosscheckExtraction, needsReview } from '../lib/ocr/crosscheck.js';
import { valuesAgree, compareCandidates } from '../lib/ocr/agreement.js';
import { candidateFor } from '../lib/ocr/fieldCandidates.js';
import { preprocessRegion } from '../lib/ocr/preprocess.js';
import { reviewField } from '../lib/review.js';
import { finalizeExtraction } from '../lib/pipeline.js';
import { redactDocument } from '../lib/redact.js';
import { maskPrivacyDocument } from '../lib/privacyDocument.js';
import { mergeChunk } from '../lib/pdfChunks.js';
import { findExtractionByHash, findUserExtractionByHash, saveGraph } from '../lib/db.js';
import { gstinCheckChar } from '../lib/idchecks.js';

const config = (extra = {}) => ({ ...ocrConfig({}), reprocess: false, ...extra });
const field = (key = 'total_amount', value = 'INR 500') => normalizeExtraction({ docType: 'invoice', fields: [{ key, value, page: 1, sourceQuote: 'Total: INR 500', confidence: 0.9 }] });
const read = (engine, value, confidence = 0.99) => ({ engine, status: 'ok', text: `Total: ${value}`, words: [],
  lines: [{ text: `Total: ${value}`, confidence, box: [100, 100, 200, 600] }], confidenceGranularity: 'line' });
const input = { file: { data: Buffer.from('mock image'), mimeType: 'image/png' }, pageCount: 1, ocrUsed: true, unreliablePages: [1] };
const check = (extraction, reads, options = {}) => crosscheckExtraction(extraction, input, {
  config: config(), dependencies: { runOcrEngines: async () => reads }, ...options,
});

test('two agreeing engines add evidence and accepted status without claiming correctness', async () => {
  const x = await check(field(), [read('tesseract', 'INR 500'), read('paddle', 'INR500')]);
  const amount = x.fields.find(f => f.key === 'total_amount');
  assert.equal(amount.value, 'INR 500'); assert.equal(amount.agreement, true);
  assert.equal(amount.agreementState, 'agreed'); assert.equal(amount.status, 'accepted');
  assert.equal(amount.ocr.confidence, 0.99); assert.equal(x.ocr.agreementIsGuarantee, false);
  assert.deepEqual(needsReview(x.fields), []);
});

test('disagreement retains both engine readings and withholds the field', async () => {
  const x = await check(field(), [read('tesseract', 'INR 500'), read('paddle', 'INR 508')]);
  const amount = x.fields.find(f => f.key === 'total_amount');
  assert.equal(amount.value, null); assert.equal(amount.normalizedValue, null);
  assert.equal(amount.agreement, false); assert.equal(amount.status, 'needs_review');
  assert.deepEqual(amount.candidates.filter(c => c.role !== 'extraction').map(c => c.value), ['INR 500', 'INR 508']);
  assert.ok(needsReview(x.fields).some(item => item.field === 'total_amount' && item.box));
});

test('a weak character in an otherwise confident amount cannot be averaged away', async () => {
  const tesseract = read('tesseract', 'INR 500');
  tesseract.words = [{ text: 'INR', confidence: 0.99, box: [110, 250, 190, 340] },
    { text: '500', confidence: 0.99, box: [110, 350, 190, 580], characters: [
      { text: '5', confidence: 0.99 }, { text: '0', confidence: 0.41 }, { text: '0', confidence: 0.99 },
    ] }];
  const x = await check(field(), [tesseract, read('paddle', 'INR500')]);
  const amount = x.fields.find(f => f.key === 'total_amount');
  assert.equal(amount.agreement, true); assert.equal(amount.status, 'needs_review'); assert.equal(amount.value, null);
  assert.equal(amount.ocr.confidence, 0.41); assert.equal(amount.ocr.threshold, 0.95);
  assert.equal(finalizeExtraction(x, { textByPage: ['Total: INR 500'], ocrUsed: true }).fields.find(f => f.key === 'total_amount').confidence, 0.41);
  assert.ok(amount.candidates.some(c => c.lowConfidenceTokens?.some(t => t.text === '0' && t.confidence === 0.41)));
});

test('reprocessing runs every engine on the crop and retains earlier readings', async () => {
  let calls = 0; let cropBox;
  const x = await crosscheckExtraction(field(), input, { config: config({ reprocess: true, maxReprocessFields: 1 }),
    dependencies: {
      preprocessRegion: async (_image, box) => { cropBox = box; return { ...input.file, region: box, steps: ['crop', 'upscale', 'otsu_binarise'] }; },
      runOcrEngines: async () => ++calls === 1 ? [read('tesseract', 'INR 500', 0.4), read('paddle', 'INR 508')]
        : [read('tesseract', 'INR 500'), read('paddle', 'INR 500')],
    } });
  const amount = x.fields.find(f => f.key === 'total_amount');
  assert.equal(calls, 2); assert.deepEqual(cropBox, [100, 100, 200, 600]);
  assert.equal(amount.status, 'reprocessed'); assert.equal(amount.value, 'INR 500');
  assert.ok(amount.candidates.some(c => c.value === 'INR 508' && c.attempt === 0));
  assert.ok(amount.candidates.some(c => c.attempt === 1));
});

test('unresolved reprocessing and missing confidence remain in the review queue', async () => {
  const x = await check(field(), [read('tesseract', 'INR 500', null), read('paddle', 'INR500')], {
    config: config({ reprocess: true }), dependencies: { runOcrEngines: async () => [read('tesseract', 'INR 500', 0.3), read('paddle', 'INR 500')],
      preprocessRegion: async () => ({ ...input.file, region: [100, 100, 200, 600], steps: ['crop'] }) },
  });
  assert.equal(x.fields.find(f => f.key === 'total_amount').status, 'needs_review');
  const unknown = compareCandidates({ type: 'amount', key: 'total_amount' }, [{ engine: 'a', value: '500', confidence: null }, { engine: 'b', value: '500', confidence: 0.99 }], config());
  assert.equal(unknown.accepted, false); assert.ok(unknown.reasons.includes('confidence_unavailable'));
});

test('normalisation tolerates case, whitespace and fuzzy letters but never changed digits', () => {
  assert.equal(valuesAgree({ type: 'string', key: 'organization' }, 'Example  Trading Company', 'exampleTradingCompany', config()), true);
  assert.equal(valuesAgree({ type: 'string', key: 'organization' }, 'Example Trading Company', 'Example Trading Companv', config()), true);
  assert.equal(valuesAgree({ type: 'id', key: 'account_id' }, '123456789012345', '123456789012346', config()), false);
  assert.equal(valuesAgree({ type: 'string', key: 'note', value: null }, 'Reference 12345678901', 'Reference 12345678902', config()), false);
  assert.equal(valuesAgree({ type: 'amount', key: 'total_amount' }, 'INR 500', 'USD 500', config()), false);
  const votes = compareCandidates({ type: 'amount', key: 'amount' }, ['500', '500', '508'].map((value, i) => ({ engine: `engine${i}`, value, confidence: 0.99 })), config());
  assert.equal(votes.accepted, false); assert.equal(votes.agreement, false); assert.equal(votes.majorityHint.guaranteed, false);
});

test('engine crashes/timeouts preserve other output and privacy blocks cloud adapters', async () => {
  let cloudCalls = 0;
  const engines = {
    tesseract: { local: true, extract: async () => read('tesseract', 'INR 500') },
    paddle: { local: true, extract: async () => { throw new Error('do not log OCR content'); } },
    stalled: { local: true, extract: async () => new Promise(() => {}) },
    cloud: { local: false, extract: async () => { cloudCalls++; return read('cloud', 'INR 500'); } },
  };
  const results = await runOcrEngines(input.file, { config: config({ engines: ['tesseract', 'paddle', 'stalled', 'cloud'], timeoutMs: 20 }), engines, privacy: true });
  assert.equal(results[0].status, 'ok'); assert.equal(results[1].error, 'OCR_ENGINE_FAILED');
  assert.equal(results[2].error, 'OCR_TIMEOUT'); assert.equal(results[3].error, 'PRIVACY_MODE'); assert.equal(cloudCalls, 0);
  const one = await check(field(), results.slice(0, 2));
  assert.equal(one.fields.find(f => f.key === 'total_amount').status, 'needs_review');
});

test('human correction accepts a candidate, preserves machine uncertainty and reset restores review', async () => {
  const raw = await check(field(), [read('tesseract', 'INR 500'), read('paddle', 'INR 508')]);
  const x = finalizeExtraction(raw, { textByPage: ['Total: INR 500'], ocrUsed: true });
  assert.ok(x.issues.some(i => i.rule === 'ocr.needs_review'));
  const corrected = reviewField(x, 'total_amount', { action: 'correct', value: 'INR 508' }, { by: 'Reviewer' });
  const amount = corrected.extraction.fields.find(f => f.key === 'total_amount');
  assert.equal(amount.status, 'accepted'); assert.equal(amount.agreement, false); assert.equal(amount.confidence, 1);
  assert.equal(needsReview(corrected.extraction.fields).length, 0);
  const reset = reviewField(corrected.extraction, 'total_amount', { action: 'reset' }, { by: 'Reviewer' });
  assert.equal(reset.extraction.fields.find(f => f.key === 'total_amount').status, 'needs_review');
  assert.equal(needsReview(reset.extraction.fields).length, 1);
});

test('candidate-only personal fields and token evidence are masked in privacy and redacted exports', () => {
  const fields = [{ key: 'holder_name', type: 'string', value: null, status: 'needs_review', candidates: [
    { engine: 'tesseract', value: 'Priya Sharma', confidence: 0.4, lowConfidenceTokens: [{ text: 'Priya', confidence: 0.4 }] },
  ] }];
  const doc = { filename: 'id.png', extraction: { fields, rawTextByPage: ['Holder name: Priya Sharma'] } };
  assert.ok(!JSON.stringify(maskPrivacyDocument(doc)).includes('Priya'));
  const redacted = redactDocument({ ...doc.extraction, filename: doc.filename, needs_review: needsReview(fields) });
  assert.ok(!JSON.stringify(redacted).includes('Priya'));
});

test('crop preprocessing is in-memory, upscales its region and returns binary pixels', async () => {
  const c = createCanvas(120, 80); const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 120, 80); ctx.fillStyle = '#888'; ctx.fillRect(30, 30, 40, 20);
  const crop = await preprocessRegion({ data: c.toBuffer('image/png') }, [300, 200, 800, 700]);
  const image = await loadImage(crop.data); assert.ok(image.width > 60);
  const rendered = createCanvas(image.width, image.height); const r = rendered.getContext('2d'); r.drawImage(image, 0, 0);
  const pixels = r.getImageData(0, 0, image.width, image.height).data;
  for (let i = 0; i < pixels.length; i += 4) assert.ok(pixels[i] === 0 || pixels[i] === 255);
  assert.ok(crop.steps.includes('median_denoise')); assert.equal(crop.region.length, 4);
});

test('clean text pages are unchanged, settings affect caching and chunk candidates keep original page numbers', async () => {
  const raw = field();
  const digital = await crosscheckExtraction(raw, { ...input, file: { ...input.file, mimeType: 'application/pdf' }, unreliablePages: [], ocrUsed: false }, { config: config() });
  assert.equal(digital, raw);
  assert.notEqual(ocrConfigHash(config()), ocrConfigHash(config({ digitThreshold: 0.99 })));
  const candidate = { engine: 'tesseract', value: '500', confidence: 0.4, page: 1 };
  const merged = mergeChunk(null, { rawExtraction: { fields: [{ key: 'total_amount', value: null, page: 1, status: 'needs_review', candidates: [candidate] }],
    entities: [], tables: [], ocr: { pages: [{ page: 1, engines: [] }], reprocessedFields: 1 } },
    doc: { extraction: { rawTextByPage: ['Total: 500'] } }, textLayerPages: [false] }, 5);
  assert.equal(merged.fields[0].page, 6); assert.equal(merged.fields[0].candidates[0].page, 6);
  assert.equal(merged.ocr.pages[0].page, 6);
});

test('cache lookup requires the current OCR settings and aliases are not independent votes', async () => {
  const hash = 'ocr-settings-test'; const current = ocrConfigHash(config());
  await saveGraph({ filename: 'cache.png', source: 'ai', fileHash: hash, extractionVersion: 123, ocrConfigHash: current, extraction: field() });
  assert.ok(await findExtractionByHash(hash, 123, current));
  assert.equal(await findExtractionByHash(hash, 123, ocrConfigHash(config({ confidenceThreshold: 0.99 }))), null);
  const same = compareCandidates({ key: 'amount', type: 'amount' }, [
    { engine: 'tesseract', value: '500', confidence: 0.99 }, { engine: 'tesseract', value: '500', confidence: 0.99 },
  ], config());
  assert.equal(same.accepted, false); assert.ok(same.reasons.includes('insufficient_engines'));
});

test('new uploads retry failed OCR engines while valid manual-review results remain cacheable', async () => {
  const owner = { guestId: 'ocr-cache-retry-owner' };
  const base = { filename: 'retry.png', source: 'ai', fileHash: 'ocr-failed-engines-cache', extractionVersion: 123, guestId: owner.guestId };
  const failed = await saveGraph({ ...base, extraction: { ...field(), ocr: { pages: [{ page: 1, engines: [
    { engine: 'tesseract', status: 'failed', error: 'OCR_TIMEOUT' },
    { engine: 'paddle', status: 'failed', error: 'OCR_ENGINE_FAILED' },
  ] }] } } });
  assert.equal(await findExtractionByHash(base.fileHash, 123), null);
  assert.equal(await findUserExtractionByHash(base.fileHash, 123, owner), null);
  const reviewed = await saveGraph({ ...base, extraction: { ...field(), fields: [{ key: 'total_amount', value: null, status: 'needs_review' }],
    ocr: { pages: [{ page: 1, engines: [{ engine: 'tesseract', status: 'ok' }, { engine: 'paddle', status: 'ok' }] }] } } });
  assert.equal((await findExtractionByHash(base.fileHash, 123))._id, reviewed._id);
  assert.equal((await findUserExtractionByHash(base.fileHash, 123, owner))._id, reviewed._id);
  assert.equal(failed.extraction.ocr.pages[0].engines[0].status, 'failed', 'historical results remain intact');
});

test('a whole-page retry cannot be accepted as an unlocated field value', async () => {
  const extraction = normalizeExtraction({ docType: 'other', fields: [{ key: 'custom', label: 'Custom', value: 'not observed', page: 1, confidence: 0.9 }] });
  const reads = ['tesseract', 'paddle'].map(engine => ({ engine, status: 'ok', text: 'Whole page unrelated text', words: [],
    lines: [{ text: 'Whole page unrelated text', confidence: 0.99, box: null }] }));
  const x = await crosscheckExtraction(extraction, input, { config: config({ reprocess: true }), dependencies: {
    runOcrEngines: async () => reads, preprocessRegion: async () => ({ ...input.file, region: [0, 0, 1000, 1000], steps: ['upscale'] }),
  } });
  const custom = x.fields.find(f => f.key === 'custom');
  assert.equal(custom.status, 'needs_review'); assert.equal(custom.value, null);
});

test('an agreed invalid GSTIN is withheld by validation and review/reset retains its checksum evidence', async () => {
  const raw = normalizeExtraction({ docType: 'invoice', fields: [
    { key: 'seller_gstin', value: '27AAACE1234F1Z0', page: 1, confidence: 0.99, sourceQuote: 'GSTIN: 27AAACE1234F1Z0' },
  ] });
  const reads = ['tesseract', 'paddle'].map(engine => ({ engine, status: 'ok', text: 'GSTIN: 27AAACE1234F1Z0', words: [],
    lines: [{ text: 'GSTIN: 27AAACE1234F1Z0', confidence: 0.99, box: [100, 100, 200, 600] }] }));
  const checked = await check(raw, reads);
  assert.equal(checked.fields.find(f => f.key === 'seller_gstin').status, 'accepted');
  const x = finalizeExtraction(checked, { textByPage: ['GSTIN: 27AAACE1234F1Z0'], ocrUsed: true });
  const gstin = x.fields.find(f => f.key === 'seller_gstin');
  assert.equal(gstin.value, null); assert.equal(gstin.status, 'needs_review'); assert.equal(gstin.agreement, true);
  assert.equal(gstin.validation.passed, false); assert.ok(gstin.validation.rules.includes('gstin.checksum'));
  assert.ok(gstin.steps_applied.includes('validator')); assert.ok(gstin.ocr.reasons.includes('validation_failed'));
  const valid = '27AAACE1234F1Z' + gstinCheckChar('27AAACE1234F1Z');
  const corrected = reviewField(x, 'seller_gstin', { action: 'correct', value: valid }, { by: 'Reviewer' }).extraction;
  assert.equal(corrected.fields.find(f => f.key === 'seller_gstin').status, 'accepted');
  assert.equal(corrected.fields.find(f => f.key === 'seller_gstin').validation.passed, true);
  assert.ok(corrected.fields.find(f => f.key === 'seller_gstin').steps_applied.includes('manual_review'));
  const reset = reviewField(corrected, 'seller_gstin', { action: 'reset' }, { by: 'Reviewer' }).extraction;
  assert.equal(reset.fields.find(f => f.key === 'seller_gstin').value, null);
  assert.ok(reset.issues.some(i => i.rule === 'gstin.checksum'));
  assert.ok(!reset.fields.find(f => f.key === 'seller_gstin').steps_applied.includes('manual_review'));
  const disabled = finalizeExtraction(checked, { textByPage: [], ocrUsed: true, ocrValidation: false });
  assert.equal(disabled.fields.find(f => f.key === 'seller_gstin').value, '27AAACE1234F1Z0');
  assert.equal(disabled.fields.find(f => f.key === 'seller_gstin').validation.passed, null);
});

test('a confident re-scan can correct O/0 and S/5 while preserving the provisional misreading', async () => {
  let attempt = 0;
  const x = await crosscheckExtraction(field('total_amount', 'INR SO0'), input, { config: config({ reprocess: true }),
    dependencies: {
      preprocessRegion: async () => ({ ...input.file, region: [100, 100, 200, 600], steps: ['crop', 'upscale'] }),
      runOcrEngines: async () => ++attempt === 1 ? [read('tesseract', 'INR SO0', 0.4), read('paddle', 'INR 500')]
        : [read('tesseract', 'INR 500'), read('paddle', 'INR 500')],
    } });
  const amount = x.fields.find(f => f.key === 'total_amount');
  assert.equal(amount.value, 'INR 500'); assert.equal(amount.normalizedValue, 500);
  assert.equal(amount.status, 'reprocessed'); assert.ok(amount.steps_applied.includes('rescan'));
  assert.ok(amount.candidates.some(c => c.value === 'INR SO0' && c.role === 'extraction'));
});
