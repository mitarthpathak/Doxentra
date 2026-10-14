// No API cache or database: both pipelines start with the same original bytes.
// Live: npm run benchmark:gemini -- --only a,f,g --repeat 3
// Offline wiring check: npm run benchmark:gemini -- --replay --only a,f,g
import '../server/lib/dns-fallback.js';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { GeminiKeyPool, configuredGeminiKeys } from '../server/lib/geminiPool.js';
import { setGeminiPool, setGeminiClient, isAiConfigured } from '../server/lib/ai.js';
import { extractDocument } from '../server/lib/extract.js';
import { analyzeGemini } from '../server/lib/geminiPipeline.js';
import { prepareDocumentInput } from '../server/lib/pdfText.js';
import { finalizeExtraction } from '../server/lib/pipeline.js';
import { asciiDigits, compactId, parseAmount, parseDate, parseNumber } from '../server/lib/normalize.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const replay = process.argv.includes('--replay');
const repeats = Math.max(1, Math.min(10, Number(arg('repeat', '1')) || 1));
const budget = Math.max(20_000, Math.min(120_000, Number(arg('budget-ms', '48000')) || 48_000));
const only = arg('only', '').split(',').filter(Boolean);
const sampleDir = path.resolve(arg('samples', path.join(root, 'samples')));
const outDir = path.resolve(arg('out', path.join(root, 'docs/benchmark')));
const truth = JSON.parse(await readFile(path.join(sampleDir, 'ground-truth.json'), 'utf8'));
const samples = Object.entries(truth.documents).filter(([name]) => !only.length || only.some(s => s === name || s === name.split('-')[0]));
if (!samples.length) throw new Error('No sample documents matched --only');
if (!replay && !isAiConfigured()) throw new Error('Configure GEMINI_API_KEY_1 / GEMINI_API_KEY_2 or GEMINI_API_KEY before a live benchmark. Use --replay for an offline check.');

const words = s => asciiDigits(String(s ?? '')).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [];
function matches(expected, field) {
  if (field?.value == null) return false;
  if (field.type === 'date') return parseDate(expected) != null && parseDate(expected) === (field.normalizedValue || parseDate(field.value));
  if (['amount', 'number'].includes(field.type)) {
    const parse = field.type === 'amount' ? parseAmount : parseNumber;
    const want = parse(expected), got = parse(field.value);
    return want != null && got != null && Math.abs(want - got) < 0.01;
  }
  if (field.type === 'id') return compactId(expected) === compactId(field.value);
  if (field.type === 'phone') return String(expected).replace(/\D/g, '').slice(-10) === String(field.value).replace(/\D/g, '').slice(-10);
  const a = words(expected), b = words(field.value), remaining = [...b];
  let hit = 0;
  for (const word of a) { const i = remaining.indexOf(word); if (i >= 0) { hit++; remaining.splice(i, 1); } }
  return a.length + b.length > 0 && 2 * hit / (a.length + b.length) >= 0.85;
}
function accuracy(extraction, expected) {
  const fields = Object.entries(expected.fields).map(([key, value]) => ({ key, correct: matches(value, extraction?.fields?.find(f => f.key === key)) }));
  const correct = fields.filter(f => f.correct).length;
  return { correct, total: fields.length, fieldAccuracy: fields.length ? correct / fields.length : null,
    classificationCorrect: extraction?.docType === expected.docType, fields };
}
const fixtureNames = replay ? await readdir(path.join(root, 'server/test/fixtures/gemini')) : [];
const rows = [];
const keys = configuredGeminiKeys();
// Baseline is the retained one-call extractor with one key; gemini uses all keys.
const baselinePool = replay ? null : new GeminiKeyPool(keys.slice(0, 1));
const geminiPool = replay ? null : new GeminiKeyPool(keys);
for (const [name, expected] of samples) {
  const bytes = await readFile(path.join(sampleDir, name));
  const mimeType = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/pdf';
  let fixture;
  if (replay) {
    const filename = fixtureNames.find(f => f.startsWith(`sample-${name[0]}-`));
    if (!filename) throw new Error(`No replay fixture for ${name}; use --live or choose existing samples`);
    fixture = JSON.parse(await readFile(path.join(root, 'server/test/fixtures/gemini', filename), 'utf8'));
  }
  for (let run = 0; run < repeats; run++) {
    // Alternate order to reduce model warmup / provider-load bias.
    for (const pipeline of run % 2 ? ['gemini', 'legacy'] : ['legacy', 'gemini']) {
      if (replay) setGeminiClient({ models: { async generateContent(req) {
        const schema = req.config.responseJsonSchema;
        if (schema.properties.visibleFields) return { text: JSON.stringify({ text: fixture.ocrText?.[0]?.text || fixture.fields.map(f => f.sourceQuote || `${f.label}: ${f.value ?? ''}`).join('\n'), visibleFields: [] }) };
        if (!schema.properties.docType) return { text: JSON.stringify({ fields: fixture.fields.filter(f => schema.properties.fields.items.properties.key.enum.includes(f.key)) }) };
        return { text: JSON.stringify(fixture) };
      } } });
      else setGeminiPool(pipeline === 'legacy' ? baselinePool : geminiPool);
      const started = performance.now();
      let output, error, basicResult = false, timings = {};
      try {
        const input = await prepareDocumentInput({ buffer: bytes, kind: mimeType === 'application/pdf' ? 'pdf' : 'image', mimeType });
        const deadline = Date.now() + budget;
        output = pipeline === 'legacy' ? await extractDocument(input, { deadline })
          : await analyzeGemini({ ...input, file: input.file || { data: bytes, mimeType } }, { deadline, metrics: timings });
        const pages = output.pipeline?.textByPage || Array.from({ length: input.pageCount }, (_, i) => input.pages[i] || output.ocrText?.find(p => p.page === i + 1)?.text || '');
        basicResult = Boolean(output.pipeline?.fallback);
        output = { ...finalizeExtraction(output, { textByPage: pages, ocrUsed: input.ocrUsed }), model: output.model };
      } catch (err) { error = { code: err.code || err.status || err.name }; }
      rows.push({ file: name, pipeline, run: run + 1, latencyMs: Math.round(performance.now() - started), timings, basicResult,
        ...(error ? { error } : { model: output.model }), ...accuracy(output, expected) });
    }
  }
}
setGeminiPool(null);
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null; };
const summary = Object.fromEntries(['legacy', 'gemini'].map(pipeline => {
  const runs = rows.filter(r => r.pipeline === pipeline);
  const correct = runs.reduce((n, r) => n + r.correct, 0), total = runs.reduce((n, r) => n + r.total, 0);
  return [pipeline, { runs: runs.length, failures: runs.filter(r => r.error).length, basicResults: runs.filter(r => r.basicResult).length, fieldAccuracy: correct / total,
    classificationAccuracy: runs.filter(r => r.classificationCorrect).length / runs.length,
    medianLatencyMs: percentile(runs.map(r => r.latencyMs), 0.5), p95LatencyMs: percentile(runs.map(r => r.latencyMs), 0.95) }];
}));
const report = { date: new Date().toISOString(), mode: replay ? 'fixture-replay (not live latency or accuracy evidence)' : 'live',
  scope: 'Original bytes → extraction; excludes storage, HTTP, caching, workspace derivations and UI. The tiered Gemini pipeline also requests concept-map/quiz source nodes.',
  baselineKeys: replay ? 0 : Math.min(1, keys.length), geminiKeys: replay ? 0 : keys.length,
  visionModel: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  reasoningModels: process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite,gemini-3.1-flash-lite',
  repeats, summary, rows };
await mkdir(outDir, { recursive: true });
const label = replay ? 'replay' : 'live';
await writeFile(path.join(outDir, `gemini-${label}.json`), JSON.stringify(report, null, 2) + '\n');
const md = `# Legacy vs gemini pipeline\n\nMode: **${report.mode}**\n\n${report.scope}\n\n| Pipeline | Runs | Failures | Basic results | Field accuracy | Classification | Median ms | P95 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|\n` + Object.entries(summary).map(([p, s]) => `| ${p} | ${s.runs} | ${s.failures} | ${s.basicResults} | ${(100 * s.fieldAccuracy).toFixed(1)}% | ${(100 * s.classificationAccuracy).toFixed(1)}% | ${s.medianLatencyMs} | ${s.p95LatencyMs} |`).join('\n') + '\n\nFailures count as incorrect fields. Basic results are explicitly flagged rule-based extraction after AI unavailability. Replay checks wiring using fixed responses and cannot demonstrate a speed or accuracy improvement. Use live repeats and representative scanned multi-page PDFs / IDs for a production comparison.\n';
await writeFile(path.join(outDir, `gemini-${label}.md`), md);
console.log(md);
if (rows.some(r => r.error)) process.exitCode = 1;
