/**
 * Ask-the-Document: questions answered from the owner's documents, with
 * citations (document + page + verbatim quote).
 *
 *  1. passages: per document a profile (type, title, summary), one fact per
 *     extracted field, one per validation issue, and overlapping chunks of
 *     the page text;
 *  2. retrieval: the search ranker's word matching (exact / prefix / typo,
 *     Hindi and English) weighted by inverse document frequency;
 *  3. one Gemini call answers ONLY from the numbered sources and cites them;
 *  4. every citation is checked: its quote must really occur in the cited
 *     source ("verified"); citations of unknown sources are dropped.
 * Without the AI (or when it fails) an extractive answer quotes the best
 * matching passages instead.
 */
import { generateStructured, parseJson } from './ai.js';
import { looseText } from './confidence.js';
import { tokenMatch, tokenize } from './search.js';

const CHUNK_CHARS = 700;
const CHUNK_OVERLAP = 150;
const MAX_SOURCES = 14;
const MAX_HISTORY_TURNS = 6;
const MAX_QUOTE = 200;

// Question words that say nothing about the content (English and Hindi).
const STOPWORDS = new Set((
  'a an the is are was were be been of to in on for from by with at as and or not no do does did what which who whom whose when where why how ' +
  'this that these those it its my me i you your our there their please tell show give list find any all some much many document documents doc ' +
  'file files about can could would should will shall has have had me us than then into also only just ' +
  'क्या का की के है हैं में से को और पर यह वह कौन कब कहाँ कहां कैसे कितना कितनी कितने था थी थे हो किस किसने'
).split(' '));

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Shorten at a word boundary with an ellipsis. */
function clip(s, max = MAX_QUOTE) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/** Split page text into overlapping chunks, preferring line breaks as boundaries. */
export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const s = String(text || '').trim();
  if (s.length <= size) return s ? [s] : [];
  const out = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + size);
    if (end < s.length) {
      const nl = s.lastIndexOf('\n', end);
      if (nl > start + size * 0.5) end = nl;
    }
    out.push(s.slice(start, end).trim());
    if (end >= s.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}

const docTitle = doc => doc.extraction?.title || doc.filename || 'Document';

/** Everything a question can be answered from, for one stored document. */
export function passagesOf(doc) {
  const x = doc.extraction || {};
  const base = { documentId: String(doc._id), title: docTitle(doc), filename: doc.filename, docTypeLabel: x.docTypeLabel || 'Document' };
  const out = [];
  out.push({
    ...base, kind: 'profile', page: null,
    text: `${base.title}: a ${x.docTypeLabel || 'document'} (file ${doc.filename}${x.pageCount ? `, ${x.pageCount} page${x.pageCount === 1 ? '' : 's'}` : ''}). ${x.summary || ''}`.trim(),
  });
  for (const f of x.fields || []) {
    if (f.value == null) continue;
    const value = Array.isArray(f.normalizedValue) ? f.normalizedValue.join('; ') : f.value;
    out.push({
      ...base, kind: 'field', fieldKey: f.key, page: f.page ?? null, confidence: f.confidence,
      text: `${f.label}: ${value}${f.sourceQuote ? ` (written as "${f.sourceQuote}")` : ''}`,
    });
  }
  for (const i of x.issues || []) {
    out.push({ ...base, kind: 'issue', page: null, fieldKey: i.fieldKeys?.[0], text: `Validation ${i.severity}: ${i.message}` });
  }
  (x.rawTextByPage || []).forEach((t, p) => {
    for (const chunk of chunkText(t)) out.push({ ...base, kind: 'text', page: p + 1, text: chunk });
  });
  return out;
}

const questionTokens = q => [...new Set(tokenize(q))].filter(t => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t))).slice(0, 16);

/**
 * Rank passages for a question: for each question word the best match in the
 * passage (1 exact, 0.7 prefix, 0.5 typo) × the word's rarity (idf), with a
 * bonus for fields and a phrase bonus. Returns passages with a score, best first.
 */
export function rankPassages(question, passages) {
  const qTokens = questionTokens(question);
  if (!qTokens.length) return [];
  const tokenized = passages.map(p => [...new Set(tokenize(p.text))]);
  const df = new Map(qTokens.map(q => [q, tokenized.filter(words => words.some(w => tokenMatch(q, w) > 0)).length]));
  const n = passages.length;
  const phrase = tokenize(question).filter(t => !STOPWORDS.has(t)).join(' ');
  const scored = passages.map((p, i) => {
    let score = 0;
    let matched = 0;
    for (const q of qTokens) {
      let best = 0;
      for (const w of tokenized[i]) {
        const s = tokenMatch(q, w);
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (best) {
        matched++;
        score += best * Math.log(1 + n / (df.get(q) || 1));
      }
    }
    if (!matched) return { ...p, score: 0 };
    if (p.kind === 'field') score *= 1.3;
    if (p.kind === 'issue') score *= 1.1;
    if (phrase.includes(' ') && tokenize(p.text).join(' ').includes(phrase)) score += 2;
    score *= 0.6 + 0.4 * (matched / qTokens.length);
    return { ...p, score: Math.round(score * 100) / 100 };
  });
  return scored.filter(p => p.score > 0).sort((a, b) => b.score - a.score);
}

/**
 * Sources for the answer: the best-ranked passages (at most a few per
 * document), plus each scoped document's profile so general questions
 * ("summarise this", "which documents…") can always be answered.
 */
export function selectSources(question, docs) {
  const passages = docs.flatMap(passagesOf);
  const ranked = rankPassages(question, passages);
  const picked = [];
  const perDoc = new Map();
  const perDocLimit = docs.length === 1 ? MAX_SOURCES : 5;
  for (const p of ranked) {
    if (picked.length >= MAX_SOURCES - Math.min(docs.length, 4)) break;
    const n = perDoc.get(p.documentId) || 0;
    if (n >= perDocLimit) continue;
    perDoc.set(p.documentId, n + 1);
    picked.push(p);
  }
  // Profiles of the scoped documents (most relevant first) give general context.
  const profileDocs = docs.length <= 4 ? docs : [...new Set(picked.map(p => p.documentId))].map(id => docs.find(d => String(d._id) === id)).filter(Boolean);
  for (const d of profileDocs.slice(0, 6)) {
    const profile = passages.find(p => p.documentId === String(d._id) && p.kind === 'profile');
    if (profile && !picked.includes(profile)) picked.push({ ...profile, score: profile.score || 0 });
  }
  if (!ranked.length && docs.length === 1) {
    // Nothing matched word for word: give the model the document's fields and first page.
    for (const p of passages.filter(x => x.kind === 'field' || (x.kind === 'text' && x.page === 1)).slice(0, MAX_SOURCES - picked.length)) picked.push({ ...p, score: 0 });
  }
  return { sources: picked.slice(0, MAX_SOURCES + 2).map((p, i) => ({ ...p, id: `S${i + 1}` })), bestScore: ranked[0]?.score || 0 };
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    answerable: { type: 'boolean' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { source: { type: 'string' }, quote: { type: 'string' } },
        required: ['source', 'quote'],
      },
    },
    followUps: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'answerable', 'citations'],
};

const INSTRUCTIONS = `You answer questions about the user's own uploaded documents (Indian forms, certificates, invoices, ID cards, letters, reports). Use ONLY the numbered SOURCES below; never use outside knowledge and never guess.

- answer: concise and direct (1-5 sentences, or a short list). After every claim put the source id(s) in square brackets, e.g. "The total is ₹18,880 [S3]." Mention which document a fact comes from when several documents are involved. Prefer exact values (amounts, dates, IDs, names) as written.
- If the sources do not contain the answer, set answerable=false and say briefly what is missing; do not invent anything.
- citations: one entry per source you used: source = its id (e.g. "S3"), quote = a short VERBATIM excerpt (max ${MAX_QUOTE} characters) copied character-for-character from that source's text that supports the claim.
- Answer in the language of the question (Hindi questions in Hindi, English in English). Keep quotes in their original language.
- followUps: up to 3 short follow-up questions the user might ask next about these documents.
- Sources marked "Validation" are automatic consistency checks on the document; you may use them to explain problems.`;

function sourceBlock(s) {
  const where = [`document "${s.title}"`, s.docTypeLabel, s.page ? `page ${s.page}` : null, s.kind === 'field' ? 'extracted field' : s.kind === 'issue' ? 'validation check' : s.kind === 'profile' ? 'document summary' : 'page text']
    .filter(Boolean).join(', ');
  return `[${s.id}] (${where})\n${s.text}`;
}

/** Whether a quote really occurs in a source (loosely: case, spacing and punctuation ignored). */
export function quoteSupported(quote, sourceText) {
  const q = looseText(String(quote || '').replace(/…$/, ''));
  if (!q) return false;
  const t = looseText(sourceText);
  if (t.includes(q)) return true;
  // Tolerate small differences: ≥ 85 % of the quote's words in the source, all of its numbers present.
  const words = q.split(' ');
  const have = new Set(t.split(' '));
  if (words.filter(w => /\d/.test(w)).some(w => !have.has(w))) return false;
  return words.filter(w => have.has(w)).length / words.length >= 0.85;
}

/**
 * Turn the model's answer into the response: citations renumbered [1], [2]…
 * in order of appearance, each with its document, page and a verified flag.
 */
export function shapeAnswer(raw, sources) {
  const byId = new Map(sources.map(s => [s.id.toUpperCase(), s]));
  const quotes = new Map();
  for (const c of Array.isArray(raw?.citations) ? raw.citations : []) {
    const id = str(c?.source, 10).toUpperCase().replace(/[^S0-9]/g, '');
    if (byId.has(id) && !quotes.has(id)) quotes.set(id, str(c?.quote, MAX_QUOTE * 2));
  }
  let answer = str(raw?.answer, 4000);
  const order = [];
  // [S3], [S3, S5], [S3][S5] → [1], [1, 2], [1][2]
  answer = answer.replace(/\[((?:\s*S\d+\s*,?)+)\]/gi, (_, list) => {
    const nums = list.split(',').map(x => x.trim().toUpperCase()).filter(id => byId.has(id)).map(id => {
      if (!order.includes(id)) order.push(id);
      return order.indexOf(id) + 1;
    });
    return nums.length ? `[${nums.join(', ')}]` : '';
  }).replace(/\s+([.,;:])/g, '$1').trim();
  // Sources cited only in the citations list still count.
  for (const id of quotes.keys()) if (!order.includes(id)) order.push(id);
  const citations = order.map((id, i) => {
    const s = byId.get(id);
    const quote = quotes.get(id) || s.text.slice(0, MAX_QUOTE);
    return {
      n: i + 1,
      documentId: s.documentId,
      title: s.title,
      filename: s.filename,
      docTypeLabel: s.docTypeLabel,
      kind: s.kind,
      page: s.page ?? null,
      ...(s.fieldKey ? { fieldKey: s.fieldKey } : {}),
      quote: clip(quote),
      // Summaries are written by the AI, so only quotes of the document's own text count as verified.
      verified: s.kind !== 'profile' && quoteSupported(quote, s.text),
    };
  });
  return {
    answer: answer || 'I could not find an answer in your documents.',
    answerable: raw?.answerable !== false && citations.length > 0,
    citations,
    followUps: (Array.isArray(raw?.followUps) ? raw.followUps : []).map(q => str(q, 160)).filter(Boolean).slice(0, 3),
  };
}

/** Sentences of a passage that contain question words (for the extractive answer). */
function bestSentence(text, qTokens) {
  const sentences = String(text).split(/(?<=[.!?।])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  let best = sentences[0] || text;
  let bestScore = -1;
  for (const s of sentences) {
    const words = tokenize(s);
    const score = qTokens.reduce((n, q) => n + (words.some(w => tokenMatch(q, w) > 0) ? 1 : 0), 0);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return clip(best);
}

/** Answer without the AI: quote the best matching passages, each cited. */
export function extractiveAnswer(question, sources) {
  const qTokens = questionTokens(question);
  const top = sources.filter(s => s.score > 0).slice(0, 3);
  if (!top.length) {
    return { answer: 'I could not find anything about that in your documents. Try other words, or search for a specific value.', answerable: false, citations: [], followUps: [] };
  }
  const citations = top.map((s, i) => {
    const quote = s.kind === 'field' ? s.text.replace(/ \(written as .*\)$/, '') : bestSentence(s.text, qTokens);
    return {
      n: i + 1, documentId: s.documentId, title: s.title, filename: s.filename, docTypeLabel: s.docTypeLabel, kind: s.kind,
      page: s.page ?? null, ...(s.fieldKey ? { fieldKey: s.fieldKey } : {}), quote, verified: s.kind !== 'profile',
    };
  });
  const lines = citations.map(c => `• ${c.quote} — ${c.title}${c.page ? `, page ${c.page}` : ''} [${c.n}]`);
  return { answer: `These passages from your documents match the question best:\n${lines.join('\n')}`, answerable: true, citations, followUps: [] };
}

/**
 * Answer a question over the given stored documents.
 * history: earlier turns [{ role: 'user'|'assistant', content }].
 */
export async function askDocuments(question, docs, { history = [], deadline } = {}) {
  const { sources, bestScore } = selectSources(question, docs);
  if (!sources.length) {
    return { answer: 'There are no documents to answer from yet. Upload a document first.', answerable: false, citations: [], followUps: [], mode: 'none', sourcesConsidered: 0 };
  }
  const turns = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY_TURNS)
    .map(t => `${t?.role === 'assistant' ? 'Assistant' : 'User'}: ${str(t?.content, 600)}`).join('\n');
  const parts = [
    { text: INSTRUCTIONS },
    { text: `SOURCES:\n${sources.map(sourceBlock).join('\n\n')}` },
    { text: `${turns ? `CONVERSATION SO FAR:\n${turns}\n\n` : ''}QUESTION: ${str(question, 1000)}` },
  ];
  try {
    const result = await generateStructured({
      parts,
      schema: ANSWER_SCHEMA,
      temperature: 0,
      deadline,
      tag: 'Ask',
      parse: text => {
        const raw = parseJson(text);
        if (typeof raw?.answer !== 'string') throw Object.assign(new Error('not an answer'), { code: 'BAD_AI_OUTPUT' });
        return shapeAnswer(raw, sources);
      },
    });
    const { model, ...answer } = result;
    return { ...answer, mode: 'ai', model, sourcesConsidered: sources.length };
  } catch (err) {
    console.error('[Ask] AI answer failed, answering extractively:', err.code || err.status || '', err.message);
    return {
      ...extractiveAnswer(question, sources),
      mode: 'extractive',
      notice: err.code === 'NO_API_KEY'
        ? 'AI is not configured on the server, so these are the best matching passages instead of a written answer.'
        : 'The AI service is busy right now, so these are the best matching passages instead of a written answer.',
      sourcesConsidered: sources.length,
      bestScore,
    };
  }
}
