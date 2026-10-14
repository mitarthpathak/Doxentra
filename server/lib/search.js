/**
 * Search over extracted documents: field values, entities, summaries,
 * validation issues, titles and page text. Ranking (used for both storage backends; with
 * MongoDB a text index first narrows the candidates):
 *   token score: exact 1.0, prefix 0.7, fuzzy (1 edit, 2 for long words) 0.5
 *   unit weight: field 3, title/filename 2.5, entity 2, summary / issue 1.5, page text 1
 *   + phrase bonus when the whole query occurs in the unit.
 * Case-insensitive; Hindi (Devanagari) and English tokens; Devanagari digits
 * match ASCII digits. Across scripts (translit.js): a Latin query matches a
 * Devanagari word by sound ("suchna" → सूचना, 0.6) and back, and common
 * document words match their translation (परीक्षा ↔ examination, 0.8).
 */
import { asciiDigits } from './normalize.js';
import { hasDevanagari, phoneticKey, translationsOf } from './translit.js';

const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const WEIGHTS = { field: 3, title: 2.5, entity: 2, summary: 1.5, issue: 1.5, text: 1 };
const MAX_HITS_PER_DOC = 3;
const SNIPPET_RADIUS = 70;

/** Lower-cased word tokens; "1,18,000" becomes one token "118000". */
export function tokenize(s) {
  const text = asciiDigits(String(s ?? '')).normalize('NFKC').toLowerCase().replace(/(\d),(?=\d)/g, '$1');
  return text.match(WORD) || [];
}

/** Edit distance with adjacent swaps counting as one edit (optimal string alignment), bounded by max. */
function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] <= max;
}

// Phonetic keys are cached: page text repeats the same words.
const keys = new Map();
const keyOf = w => {
  if (!keys.has(w)) {
    if (keys.size > 50_000) keys.clear();
    keys.set(w, phoneticKey(w));
  }
  return keys.get(w);
};

/** How well one word matches one query token (0 = no match). */
export function tokenMatch(queryToken, word) {
  if (word === queryToken) return 1;
  if (hasDevanagari(queryToken) !== hasDevanagari(word)) {
    // Different scripts: compare how they sound (short tokens would match too much).
    if (queryToken.length < 3 || /^\d+$/.test(queryToken) || /^\d+$/.test(word)) return 0;
    const q = keyOf(queryToken);
    const w = keyOf(word);
    if (q.length < 2) return 0;
    return q === w ? 0.6 : q.length >= 3 && w.startsWith(q) ? 0.45 : 0;
  }
  if (queryToken.length >= 2 && word.startsWith(queryToken)) return 0.7;
  const maxEdits = queryToken.length >= 8 ? 2 : queryToken.length >= 4 ? 1 : 0;
  if (maxEdits && editDistanceAtMost(queryToken, word, maxEdits)) return 0.5;
  return 0;
}

/** A query token and its glossary translations: [{ token, weight }]. */
const alternatives = q => [{ token: q, weight: 1 }, ...translationsOf(q).map(t => ({ token: t, weight: 0.8 }))];

/** Score a text unit for the query tokens; null when too few tokens match. */
function scoreUnit(text, qTokens, phrase) {
  const words = tokenize(text);
  if (!words.length) return null;
  let total = 0;
  let matched = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const alt of alternatives(q)) {
      for (const w of words) {
        const s = tokenMatch(alt.token, w) * alt.weight;
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (best === 1) break;
    }
    if (best) matched++;
    total += best;
  }
  // Every token must match for short queries; most of them for long ones.
  if (matched < Math.max(1, Math.ceil(qTokens.length * (qTokens.length > 2 ? 0.66 : 1)))) return null;
  const phraseBonus = qTokens.length > 1 && tokenize(text).join(' ').includes(phrase) ? 1 : 0;
  return total / qTokens.length + phraseBonus;
}

/**
 * A short excerpt around the first match with highlight ranges
 * ([start, end) offsets into `snippet`); the client renders the marks.
 */
export function makeSnippet(text, qTokens, radius = SNIPPET_RADIUS) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  const words = [...source.matchAll(WORD)];
  const isHit = w => {
    const t = tokenize(w)[0] || '';
    return qTokens.some(q => alternatives(q).some(a => tokenMatch(a.token, t) > 0));
  };
  const first = words.find(m => isHit(m[0]));
  let start = 0;
  let end = source.length;
  if (source.length > radius * 2 && first) {
    start = Math.max(0, first.index - radius);
    end = Math.min(source.length, first.index + first[0].length + radius);
    // Do not cut words in half.
    if (start > 0) start = source.indexOf(' ', start) + 1 || start;
    const space = source.lastIndexOf(' ', end);
    if (end < source.length && space > first.index) end = space;
  } else if (source.length > radius * 2) {
    end = radius * 2;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  const body = source.slice(start, end);
  const highlights = [...body.matchAll(WORD)]
    .filter(m => isHit(m[0]))
    .map(m => [prefix.length + m.index, prefix.length + m.index + m[0].length]);
  return { snippet: prefix + body + suffix, highlights };
}

/** Everything searchable in one stored document. */
function unitsOf(doc) {
  const x = doc.extraction || {};
  const units = [];
  units.push({ kind: 'title', label: 'Title', value: x.title || doc.filename, text: `${x.title || ''} ${doc.filename || ''}`, page: null, confidence: x.overallConfidence });
  for (const f of x.fields || []) {
    if (f.value == null) continue;
    const value = Array.isArray(f.value) ? f.value.join('; ') : String(f.value);
    units.push({ kind: 'field', fieldKey: f.key, label: f.label, value, text: `${value} ${f.label}`, snippetText: value, page: f.page, confidence: f.confidence, sourceQuote: f.sourceQuote });
  }
  for (const e of x.entities || []) {
    units.push({ kind: 'entity', label: e.type, value: e.value, text: e.value, page: e.page, confidence: e.confidence, sourceQuote: e.sourceQuote });
  }
  if (x.summary) units.push({ kind: 'summary', label: 'Summary', value: x.summary, text: x.summary, page: null, confidence: x.overallConfidence });
  for (const i of x.issues || []) {
    units.push({ kind: 'issue', fieldKey: i.fieldKeys?.[0], label: `${i.severity} · ${i.type.replace('_', ' ')}`, value: i.message, text: i.message, page: null, confidence: x.overallConfidence });
  }
  (x.rawTextByPage || []).forEach((t, i) => {
    if (t) units.push({ kind: 'text', label: `Page ${i + 1} text`, value: null, text: t, page: i + 1, confidence: x.overallConfidence });
  });
  return units;
}

function summaryOf(doc) {
  const x = doc.extraction || {};
  return {
    documentId: String(doc._id),
    filename: doc.filename,
    title: x.title || doc.filename,
    docType: x.docType,
    docTypeLabel: x.docTypeLabel,
    overallConfidence: x.overallConfidence ?? null,
    createdAt: doc.createdAt,
  };
}

/** Whether a document passes the type / date filters. */
export function matchesFilters(doc, { type, from, to } = {}) {
  const x = doc.extraction || {};
  if (type && x.docType !== type) return false;
  const created = new Date(doc.createdAt).getTime();
  if (from && created < new Date(from).getTime()) return false;
  if (to && created > new Date(to).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(to) ? 86_399_999 : 0)) return false;
  return true;
}

/**
 * Rank documents for a query. Returns hits sorted by score:
 * { documentId, title, filename, docType, docTypeLabel, kind, fieldKey?,
 *   label, value, snippet, highlights, page, confidence, sourceQuote?, score }.
 * minConfidence applies to each hit (fields/entities: their own confidence;
 * summary/text: the document's overall confidence). An empty query lists the
 * documents that pass the filters.
 */
export function searchDocuments(docs, { q = '', type, minConfidence, from, to, limit = 50 } = {}) {
  const qTokens = [...new Set(tokenize(q))].slice(0, 12);
  const phrase = tokenize(q).join(' ');
  const min = Number.isFinite(Number(minConfidence)) && minConfidence !== '' && minConfidence != null ? Number(minConfidence) : null;
  const hits = [];
  for (const doc of docs) {
    if (!matchesFilters(doc, { type, from, to })) continue;
    const base = summaryOf(doc);
    if (!qTokens.length) {
      if (min != null && (base.overallConfidence ?? 0) < min) continue;
      const summary = doc.extraction?.summary || '';
      hits.push({ ...base, kind: 'document', label: 'Summary', value: null, ...makeSnippet(summary, []), page: null, confidence: base.overallConfidence, score: 0 });
      continue;
    }
    const docHits = [];
    for (const unit of unitsOf(doc)) {
      const s = scoreUnit(unit.text, qTokens, phrase);
      if (s == null) continue;
      if (min != null && (unit.confidence ?? 0) < min) continue;
      const { snippet, highlights } = makeSnippet(unit.snippetText ?? unit.text, qTokens);
      docHits.push({
        ...base,
        kind: unit.kind,
        ...(unit.fieldKey ? { fieldKey: unit.fieldKey } : {}),
        label: unit.label,
        value: unit.value,
        snippet,
        highlights,
        page: unit.page,
        confidence: unit.confidence ?? null,
        ...(unit.sourceQuote ? { sourceQuote: unit.sourceQuote } : {}),
        score: Math.round(s * WEIGHTS[unit.kind] * 100) / 100,
      });
    }
    docHits.sort((a, b) => b.score - a.score);
    hits.push(...docHits.slice(0, MAX_HITS_PER_DOC));
  }
  hits.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
  return hits.slice(0, limit);
}
