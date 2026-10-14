// npm run benchmark:ocr -- --replay --only e,f
// Live: omit --replay. Optional --reviews corrections.json uses real reviewed
// values; --simulate-review explicitly demonstrates an oracle upper bound.
import '../server/env.js';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { extractDocument, normalizeExtraction } from '../server/lib/extract.js';
import { isAiConfigured } from '../server/lib/ai.js';
import { prepareDocumentInput } from '../server/lib/pdfText.js';
import { crosscheckExtraction, readOcrInput } from '../server/lib/ocr/crosscheck.js';
import { ocrConfig } from '../server/lib/ocr/config.js';
import { finalizeExtraction } from '../server/lib/pipeline.js';
import { reviewField } from '../server/lib/review.js';
import { shutdownOfflineOcr } from '../server/lib/offlineOcr.js';
import { shutdownPaddleOcr } from '../server/lib/ocr/engines.js';
import { measureFields, summarizeStages } from './lib/ocrMetrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const replay = process.argv.includes('--replay');
const simulateReview = process.argv.includes('--simulate-review');
const samplesDir = path.resolve(arg('samples', path.join(root, 'samples')));
const outDir = path.resolve(arg('out', path.join(root, 'docs/benchmark')));
const only = arg('only', '').split(',').filter(Boolean);
const truth = JSON.parse(await readFile(path.join(samplesDir, 'ground-truth.json'), 'utf8'));
const samples = Object.entries(truth.documents).filter(([file]) => !only.length || only.includes(file) || only.includes(file.split('-')[0]));
const reviews = arg('reviews', '') ? JSON.parse(await readFile(path.resolve(arg('reviews')), 'utf8')) : {};
if (!samples.length) throw new Error('No matching sample documents.');
if (simulateReview && arg('reviews', '')) throw new Error('Choose --reviews or --simulate-review, not both.');
if (!replay && !isAiConfigured()) throw new Error('Configure Gemini or use --replay for a fixture baseline with real local OCR.');
const fixturesDir = path.join(root, 'server/test/fixtures/gemini');
const fixtures = replay ? await readdir(fixturesDir) : [];
const config = { ...ocrConfig(), enabled: true, validation: true };
const stages = ['gemini_only', 'crosscheck', 'rescan', 'validation', 'human_review'];
const rows = [];
try {
  for (const [file, expected] of samples) {
    let output, input, textByPage;
    const started = performance.now();
    const add = (stage, extraction, extra = {}) => rows.push({ file, stage, elapsedMs: Math.round(performance.now() - started),
      ...measureFields(extraction, expected), ...extra });
    let nextStage = 0;
    try {
      const bytes = await readFile(path.join(samplesDir, file));
      const mimeType = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'application/pdf';
      input = await prepareDocumentInput({ buffer: bytes, kind: mimeType === 'application/pdf' ? 'pdf' : 'image', mimeType });
      input = { ...input, file: { data: bytes, mimeType } };
      if (replay) {
        const fixture = fixtures.find(name => name.startsWith(`sample-${file[0]}-`));
        if (!fixture) throw Object.assign(new Error('Missing replay fixture'), { code: 'NO_REPLAY_FIXTURE' });
        output = { ...normalizeExtraction(JSON.parse(await readFile(path.join(fixturesDir, fixture), 'utf8')), { pageCount: input.pageCount }), model: 'gemini-fixture' };
      } else output = await extractDocument(input, { deadline: Date.now() + 120_000 });
      textByPage = Array.from({ length: input.pageCount }, (_, i) => input.pages[i] || output.ocrText?.find(p => p.page === i + 1)?.text || '');
      const baseline = structuredClone(output);
      add('gemini_only', output); nextStage++;
      const records = await readOcrInput(input, { config, deadline: Date.now() + 120_000 });
      output = await crosscheckExtraction(structuredClone(baseline), input, { config: { ...config, reprocess: false }, records });
      add('crosscheck', output, { enginePages: output.ocr?.pages || [] }); nextStage++;
      output = await crosscheckExtraction(structuredClone(baseline), input, { config: { ...config, reprocess: true }, records,
        deadline: Date.now() + 120_000 });
      add('rescan', output, { reprocessedFields: output.ocr?.reprocessedFields || 0 }); nextStage++;
      output = { ...finalizeExtraction(output, { textByPage, ocrUsed: input.ocrUsed, quality: expected.upload?.quality, ocrValidation: true }),
        rawTextByPage: textByPage };
      add('validation', output, { rules: output.issues.map(i => i.rule) }); nextStage++;
      const corrections = simulateReview ? Object.fromEntries(Object.entries(expected.fields)
        .filter(([key]) => output.fields.some(f => f.key === key && f.status === 'needs_review'))
        .map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])) : reviews[file] || {};
      let reviewCount = 0;
      for (const [key, value] of Object.entries(corrections)) {
        const field = output.fields.find(f => f.key === key);
        const action = field?.value === value && field.status !== 'needs_review' ? 'confirm' : 'correct';
        output = reviewField(output, key, { action, value }, { by: simulateReview ? 'Oracle simulation' : 'Benchmark reviewer' }).extraction;
        reviewCount++;
      }
      add('human_review', output, { reviewCount, reviewMode: simulateReview ? 'oracle simulation; not measured human accuracy' : reviewCount ? 'supplied corrections' : 'not performed' });
    } catch (err) {
      // Failed stages count as missing fields, so the denominator cannot shrink.
      for (const stage of stages.slice(nextStage)) add(stage, null, { error: err.code || err.name });
      console.warn(`${file}: evaluation failed (${err.code || err.name})`);
    }
    console.log(`${file}: evaluation complete`);
  }
} finally { await shutdownOfflineOcr(); await shutdownPaddleOcr(); }

const summary = summarizeStages(rows, stages);
const report = { date: new Date().toISOString(), mode: replay ? 'fixture baseline + real local OCR (not live Gemini accuracy)' : 'live Gemini + real local OCR',
  metricScope: 'CER/WER over annotated field values; withheld values count as deletions. These are not whole-page transcription metrics.',
  config, humanReview: simulateReview ? 'oracle simulation' : arg('reviews', '') ? 'supplied corrections' : 'not performed', summary, rows };
const pct = value => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const md = `# OCR stage evaluation\n\nMode: **${report.mode}**. Human review: **${report.humanReview}**.\n\n${report.metricScope}\n\n` +
  '| Stage | Field accuracy | Emitted accuracy | Coverage | CER | WER | Pending | Failures |\n|---|---:|---:|---:|---:|---:|---:|---:|\n' +
  stages.map(stage => { const s = summary[stage]; return `| ${stage} | ${pct(s.fieldAccuracy)} | ${pct(s.emittedAccuracy)} | ${pct(s.coverage)} | ${pct(s.cer)} | ${pct(s.wer)} | ${s.pending} | ${s.failures} |`; }).join('\n') +
  '\n\nField accuracy counts every expected field; emitted accuracy describes only returned values. Withholding can lower field accuracy while improving emitted accuracy. Agreement is not correctness. Validation flags invalid values; it does not invent corrected text. Human review changes values only with supplied corrections or an explicitly labelled oracle simulation. No stage is required to improve these numbers.\n';
await mkdir(outDir, { recursive: true });
const label = replay ? 'replay' : 'live';
await writeFile(path.join(outDir, `ocr-stages-${label}.json`), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(outDir, `ocr-stages-${label}.md`), md);
console.log(md);
if (rows.some(row => row.error)) process.exitCode = 1;
