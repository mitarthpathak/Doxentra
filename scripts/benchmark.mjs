// Benchmark of the extraction pipeline against samples/ground-truth.json:
// document type and subtype accuracy, field precision / recall / F1, how
// well the confidence bands predict correct values, detection of the planted
// problems (and false alarms), and latency per document.
//
// Usage: node scripts/benchmark.mjs [--api http://localhost:3001] [--label mock] [--out docs/benchmark] [--only a,b,k]
//        node scripts/benchmark.mjs --from docs/benchmark/benchmark-mock.json   (report again from a saved run)
//   Run it against a freshly started API (scripts/mock-api.mjs, or `npm run server`
//   for live Gemini): extractions are cached by file hash, and a cached answer
//   would measure the cache, not the AI. Each sample is uploaded on its own, one
//   after the other, to a new account.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { asciiDigits, compactId, parseAmount, parseDate, parseNumber } from '../server/lib/normalize.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const API = `${arg('api', 'http://localhost:3001').replace(/\/$/, '')}/api`;
const LABEL = arg('label', 'run');
const OUT = arg('out', 'docs/benchmark');
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',')) : null;
const FROM = arg('from', '');

const truth = JSON.parse(readFileSync('samples/ground-truth.json', 'utf8'));
const samples = Object.entries(truth.documents).filter(([file]) => !ONLY || ONLY.has(file[0]));
const mime = f => (f.endsWith('.jpg') ? 'image/jpeg' : f.endsWith('.png') ? 'image/png' : 'application/pdf');

// ─── Comparing values ────────────────────────────────────────────────
const words = s => asciiDigits(String(s ?? '')).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [];
function tokenF1(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.length || !y.length) return 0;
  const pool = [...y];
  let hit = 0;
  for (const w of x) {
    const i = pool.indexOf(w);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  const p = hit / x.length;
  const r = hit / y.length;
  return p + r ? (2 * p * r) / (p + r) : 0;
}
const numberOf = f => (typeof f.normalizedValue === 'number' ? f.normalizedValue : f.type === 'number' ? parseNumber(f.value) : parseAmount(f.value));

/** Whether an extracted field has the expected value (normalised by field type). */
function matches(expected, f) {
  if (f.value == null) return false;
  switch (f.type) {
    case 'date':
      return parseDate(expected) != null && parseDate(expected) === (f.normalizedValue || parseDate(f.value));
    case 'amount':
    case 'number': {
      const want = f.type === 'number' ? parseNumber(expected) : parseAmount(expected);
      const got = numberOf(f);
      return want != null && got != null && Math.abs(want - got) < 0.01;
    }
    case 'id':
      return compactId(expected) === compactId(f.value);
    case 'phone':
      return String(expected).replace(/\D/g, '').slice(-10) === String(f.value).replace(/\D/g, '').slice(-10);
    default:
      return words(expected).join(' ') === words(f.value).join(' ') || tokenF1(expected, f.value) >= 0.85;
  }
}

// ─── Running the samples ─────────────────────────────────────────────
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

let runs = [];
let crossRules = [];
let health = {};
let started = new Date().toISOString();
if (FROM) {
  const saved = JSON.parse(readFileSync(FROM, 'utf8'));
  ({ runs } = saved);
  crossRules = saved.cross;
  health = { ai: saved.summary.ai };
  started = saved.summary.date;
} else {
const signup = await json(await fetch(`${API}/auth/signup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `bench${Date.now()}@example.com`, password: 'secret12', phone: '9876543210', age: 30 }),
}));
if (!signup.token) throw new Error(`Sign-up failed: ${JSON.stringify(signup)}`);
const auth = { authorization: `Bearer ${signup.token}` };
health = await json(await fetch(`${API}/health`));

for (const [file, t] of samples) {
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(`samples/${file}`)], { type: mime(file) }), file);
  if (t.upload?.quality) fd.append('quality', JSON.stringify([t.upload.quality]));
  const started = performance.now();
  const res = await fetch(`${API}/extract`, { method: 'POST', body: fd, headers: auth });
  const body = await json(res);
  const ms = Math.round(performance.now() - started);
  const doc = body.documents?.[0];
  if (!doc?.success) {
    console.log(`${file}: FAILED (${res.status}) ${doc?.error || body.error}`);
    runs.push({ file, failed: true, error: doc?.error || body.error, ms });
    continue;
  }
  const fields = Object.entries(t.fields).map(([key, expected]) => {
    const f = doc.fields.find(x => x.key === key);
    const alternatives = Array.isArray(expected) ? expected : [expected];
    const status = !f || f.value == null ? 'missing' : alternatives.some(v => matches(v, f)) ? 'correct' : 'wrong';
    return { key, expected: alternatives[0], got: f?.value ?? null, status, confidence: f?.confidence ?? 0, band: f?.confidenceBand || 'low' };
  });
  const raised = doc.issues.filter(i => i.severity !== 'info').map(i => i.rule);
  const expectedIssues = t.issues || [];
  runs.push({
    file, ms, serverMs: body.elapsedMs ?? null, cached: Boolean(doc.cached), ocrUsed: doc.ocrUsed, fallbackUsed: doc.fallbackUsed, model: doc.model,
    docType: doc.docType, typeOk: doc.docType === t.docType, docSubtype: doc.docSubtype, subtypeOk: doc.docSubtype === t.docSubtype,
    typeConfidence: doc.docTypeConfidence, overallConfidence: doc.overallConfidence,
    fields,
    issues: { expected: expectedIssues, found: expectedIssues.filter(r => raised.includes(r)), missed: expectedIssues.filter(r => !raised.includes(r)),
      falseAlarms: raised.filter(r => !expectedIssues.includes(r) && !(t.allowedIssues || []).includes(r)) },
  });
  const ok = fields.filter(f => f.status === 'correct').length;
  console.log(`${file.padEnd(40)} ${String(ms).padStart(6)} ms  ${doc.docType === t.docType ? 'type ok ' : `TYPE ${doc.docType}`}  fields ${ok}/${fields.length}${doc.cached ? '  (cached!)' : ''}${doc.fallbackUsed ? '  (rule-based: AI unavailable)' : ''}`);
}

const cross = await json(await fetch(`${API}/crosscheck`, { headers: auth }));
crossRules = (cross.issues || []).map(i => i.rule);
}
const crossExpected = ONLY ? [] : truth.crossIssues || [];

// ─── Metrics ─────────────────────────────────────────────────────────
const done = runs.filter(r => !r.failed);
const allFields = done.flatMap(r => r.fields);
/** Field precision / recall / F1 over a set of documents. */
function fieldScores(docs) {
  const fs = docs.flatMap(r => r.fields);
  const [c, w, m] = ['correct', 'wrong', 'missing'].map(st => fs.filter(f => f.status === st).length);
  const p = c / Math.max(1, c + w);
  const r = c / Math.max(1, fs.length);
  return { expected: fs.length, correct: c, wrong: w, missing: m, precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}
const { correct, wrong, missing, precision, recall, f1 } = fieldScores(done);
// Documents the AI answered (not the rule-based fallback used when it is unavailable).
const aiDocs = done.filter(r => !r.fallbackUsed);
const aiScores = fieldScores(aiDocs);
const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null;
};
const latency = xs => ({ n: xs.length, mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: xs.length ? Math.max(...xs) : null });
const bands = Object.fromEntries(['high', 'medium', 'low'].map(b => {
  const xs = allFields.filter(f => f.status !== 'missing' && f.band === b);
  return [b, { n: xs.length, accuracy: xs.length ? xs.filter(f => f.status === 'correct').length / xs.length : null }];
}));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const issuesExpected = done.flatMap(r => r.issues.expected).length + crossExpected.length;
const issuesFound = done.flatMap(r => r.issues.found).length + crossExpected.filter(r => crossRules.includes(r)).length;

const summary = {
  label: LABEL,
  api: API,
  ai: health.ai,
  date: started,
  documents: runs.length,
  fallbacks: done.filter(r => r.fallbackUsed).map(r => r.file),
  failed: runs.filter(r => r.failed).length,
  cachedHits: done.filter(r => r.cached).length,
  type: { accuracy: done.filter(r => r.typeOk).length / Math.max(1, done.length), subtypeAccuracy: done.filter(r => r.subtypeOk).length / Math.max(1, done.length) },
  fields: { expected: allFields.length, correct, wrong, missing, precision, recall, f1 },
  aiFields: { documents: aiDocs.length, ...aiScores },
  confidence: {
    bands,
    meanCorrect: mean(allFields.filter(f => f.status === 'correct').map(f => f.confidence)),
    meanWrong: mean(allFields.filter(f => f.status === 'wrong').map(f => f.confidence)),
  },
  issues: {
    expected: issuesExpected, found: issuesFound, recall: issuesExpected ? issuesFound / issuesExpected : null,
    missed: [...done.flatMap(r => r.issues.missed.map(m => `${r.file[0]}:${m}`)), ...crossExpected.filter(r => !crossRules.includes(r)).map(r => `cross:${r}`)],
    falseAlarms: done.flatMap(r => r.issues.falseAlarms.map(m => `${r.file[0]}:${m}`)),
  },
  latencyMs: { all: latency(done.map(r => r.ms)), text: latency(done.filter(r => !r.ocrUsed).map(r => r.ms)), ocr: latency(done.filter(r => r.ocrUsed).map(r => r.ms)) },
};

// ─── Report ──────────────────────────────────────────────────────────
const pct = x => (x == null ? '–' : `${(x * 100).toFixed(1)} %`);
const rows = done.map(r => {
  const ok = r.fields.filter(f => f.status === 'correct').length;
  const bad = r.fields.filter(f => f.status !== 'correct').map(f => `${f.key} (${f.status === 'missing' ? 'missing' : `"${f.got}"`})`);
  return `| ${r.file} | ${r.ms} | ${r.ocrUsed ? 'OCR' : 'text'}${r.fallbackUsed ? ' · **rule-based** (AI unavailable)' : ''} | ${r.typeOk ? '✓' : `✗ ${r.docType}`} | ${r.subtypeOk ? '✓' : `✗ ${r.docSubtype}`} | ${ok}/${r.fields.length} | ${r.issues.found.length}/${r.issues.expected.length} | ${bad.join(', ') || '–'} |`;
});
const md = `# Benchmark: ${LABEL}

${summary.date.slice(0, 10)} · API ${API} · AI ${summary.ai} · ${summary.documents} documents${summary.failed ? ` (${summary.failed} failed)` : ''}${summary.cachedHits ? ` · **${summary.cachedHits} answered from the cache**` : ''}
${summary.fallbacks.length ? `\n**${summary.fallbacks.length} document(s) got the rule-based extraction because the AI did not answer in time** (${summary.fallbacks.join(', ')}); the second line of field scores leaves them out.\n` : ''}
| Measure | Result |
|---|---|
| Document type accuracy | ${pct(summary.type.accuracy)} |
| Subtype accuracy | ${pct(summary.type.subtypeAccuracy)} |
| Field precision (correct / extracted) | ${pct(precision)} |
| Field recall (correct / expected) | ${pct(recall)} |
| Field F1 | ${pct(f1)} |${summary.fallbacks.length ? `\n| Field precision / recall / F1, AI answers only (${aiDocs.length} documents) | ${pct(aiScores.precision)} / ${pct(aiScores.recall)} / ${pct(aiScores.f1)} |` : ''}
| Fields correct / wrong / missing | ${correct} / ${wrong} / ${missing} of ${allFields.length} |
| Accuracy of "high" confidence values (n) | ${pct(bands.high.accuracy)} (${bands.high.n}) |
| Accuracy of "medium" / "low" values (n) | ${pct(bands.medium.accuracy)} (${bands.medium.n}) / ${pct(bands.low.accuracy)} (${bands.low.n}) |
| Mean confidence: correct / wrong values | ${pct(summary.confidence.meanCorrect)} / ${pct(summary.confidence.meanWrong)} |
| Planted problems found | ${issuesFound} / ${issuesExpected}${summary.issues.missed.length ? ` (missed: ${summary.issues.missed.join(', ')})` : ''} |
| False alarms (unexpected errors / warnings) | ${summary.issues.falseAlarms.length}${summary.issues.falseAlarms.length ? `: ${summary.issues.falseAlarms.join(', ')}` : ''} |
| Latency per document, p50 / p95 / max | ${summary.latencyMs.all.p50} / ${summary.latencyMs.all.p95} / ${summary.latencyMs.all.max} ms |
| Text-layer PDFs, p50 (n) | ${summary.latencyMs.text.p50 ?? '–'} ms (${summary.latencyMs.text.n}) |
| Scans and photos (OCR), p50 (n) | ${summary.latencyMs.ocr.p50 ?? '–'} ms (${summary.latencyMs.ocr.n}) |

| Sample | ms | Read | Type | Subtype | Fields | Problems | Not correct |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}

Ground truth: \`samples/ground-truth.json\`. Values are compared after normalisation by field type
(dates as ISO dates, amounts as numbers, IDs without spaces, text by words). Command:
\`node scripts/benchmark.mjs --api ${API.replace(/\/api$/, '')} --label ${LABEL}\`.
`;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/benchmark-${LABEL}.json`, JSON.stringify({ summary, runs, cross: crossRules }, null, 2));
writeFileSync(`${OUT}/benchmark-${LABEL}.md`, md);
console.log(`\nType ${pct(summary.type.accuracy)} · subtype ${pct(summary.type.subtypeAccuracy)} · fields P ${pct(precision)} R ${pct(recall)} F1 ${pct(f1)} · problems ${issuesFound}/${issuesExpected} · false alarms ${summary.issues.falseAlarms.length} · p50 ${summary.latencyMs.all.p50} ms`);
console.log(`Report: ${OUT}/benchmark-${LABEL}.md`);
