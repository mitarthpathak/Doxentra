/**
 * Translation of a stored document between Hindi and English.
 *
 * The AI translates the title, the summary, the free-text field values and
 * the page text (names, numbers, IDs, dates and amounts stay as written).
 * When the AI is not available, Hindi is transliterated to Latin letters
 * instead (translit.js), so a reader of English can still read names and
 * places: { method: 'transliteration' }.
 *
 * Result: { language, method: 'ai' | 'transliteration', model?, title,
 *           summary, fields: [{ key, label, original, value }],
 *           pages: [{ page, text }], basedOn, createdAt, transliterated? }
 * (transliterated: how many parts of an English translation still had Hindi,
 * now in Latin letters).
 */
import { generateStructured, isAiConfigured } from './ai.js';
import { hasDevanagari, transliterate } from './translit.js';
import { isPrivacyMode } from './privacy.js';

export const LANGUAGES = { en: 'English', hi: 'Hindi' };
const MAX_PAGES = 5;
const MAX_PAGE_CHARS = 6000;
const AI_BUDGET_MS = 45_000;
// Field types whose values are words, not numbers, codes or dates.
const TEXT_TYPES = new Set(['string', 'list', 'enum']);

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    fields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    pages: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, text: { type: 'string' } }, required: ['page', 'text'] } },
  },
  required: ['title', 'summary', 'fields', 'pages'],
};

const needsTranslation = (text, to) => (to === 'en' ? hasDevanagari(text) : /[A-Za-z]{3}/.test(text));

/** What there is to translate in one direction. */
function sourceOf(extraction, to) {
  const fields = (extraction.fields || [])
    .filter(f => f.value != null && TEXT_TYPES.has(f.type) && needsTranslation(String(f.value), to))
    .map(f => ({ key: f.key, label: f.label, value: String(f.value) }));
  const pages = (extraction.rawTextByPage || []).slice(0, MAX_PAGES)
    .map((t, i) => ({ page: i + 1, text: String(t || '').slice(0, MAX_PAGE_CHARS) }))
    .filter(p => p.text.trim() && needsTranslation(p.text, to));
  return { title: extraction.title || '', summary: extraction.summary || '', fields, pages };
}

// Bilingual documents repeat each line in both languages, and a model told to leave
// target-language text alone tends to leave the whole line, so the rules are explicit.
const RULES = {
  en: [
    '- Translate every word written in Devanagari (Hindi) into English. In bilingual text ("हिंदी / English") replace the Hindi part with its English translation, even when it repeats the English next to it. The answer must contain no Devanagari.',
    '- Names of people and organisations written in Devanagari: write them in Latin letters (आदर्श पब्लिक स्कूल → Adarsh Public School).',
  ],
  hi: [
    '- Translate every English word and sentence into Hindi (Devanagari). In bilingual text replace the English part with its Hindi translation.',
    '- Names of people and organisations stay as written; you may add their Devanagari spelling in brackets.',
  ],
};

function prompt(source, to) {
  return [
    `TRANSLATION TASK: translate this document content into ${LANGUAGES[to]}, faithfully and completely.`,
    'Rules:',
    ...RULES[to],
    '- Keep numbers, IDs, codes, dates and amounts exactly as written. Keep the line breaks of the page text.',
    'Answer with JSON: title, summary, fields [{ key, value }] for the given keys, pages [{ page, text }].',
    '',
    'SOURCE (JSON):',
    JSON.stringify(source),
  ].join('\n');
}

/** An English translation must be readable without Hindi: Devanagari the AI left is transliterated. */
function latinOnly(result) {
  let left = 0;
  const fix = text => {
    if (!hasDevanagari(text)) return text;
    left++;
    return transliterate(text);
  };
  return {
    ...result,
    title: fix(result.title),
    summary: fix(result.summary),
    fields: result.fields.map(f => ({ ...f, value: fix(f.value) })),
    pages: result.pages.map(p => ({ ...p, text: fix(p.text) })),
    ...(left ? { transliterated: left } : {}),
  };
}

function parseAnswer(text, source) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw.title !== 'string' || typeof raw.summary !== 'string') {
    throw Object.assign(new Error('not a translation'), { code: 'BAD_AI_OUTPUT' });
  }
  const byKey = new Map((Array.isArray(raw.fields) ? raw.fields : []).filter(f => f && typeof f.value === 'string').map(f => [f.key, f.value.trim()]));
  const byPage = new Map((Array.isArray(raw.pages) ? raw.pages : []).filter(p => p && typeof p.text === 'string').map(p => [Number(p.page), p.text]));
  return {
    title: raw.title.trim().slice(0, 300) || source.title,
    summary: raw.summary.trim().slice(0, 3000) || source.summary,
    fields: source.fields.map(f => ({ key: f.key, label: f.label, original: f.value, value: (byKey.get(f.key) || f.value).slice(0, 1000) })),
    pages: source.pages.map(p => ({ page: p.page, text: (byPage.get(p.page) || '').slice(0, MAX_PAGE_CHARS * 2) })).filter(p => p.text.trim()),
  };
}

/** Hindi → Latin letters, without the AI. */
function transliterated(source) {
  return {
    title: transliterate(source.title),
    summary: transliterate(source.summary),
    fields: source.fields.map(f => ({ key: f.key, label: f.label, original: f.value, value: transliterate(f.value, { capitalize: /name/.test(f.key) }) })),
    pages: source.pages.map(p => ({ page: p.page, text: transliterate(p.text) })),
  };
}

/**
 * Translate a stored document (`to`: 'en' | 'hi'). Throws { status } when
 * the language is unknown or a translation to Hindi needs the AI.
 */
export async function translateDocument(doc, { to = 'en', now = new Date() } = {}) {
  if (!LANGUAGES[to]) throw Object.assign(new Error(`Language must be one of: ${Object.keys(LANGUAGES).join(', ')}.`), { status: 400 });
  if (isPrivacyMode() && to !== 'en') throw Object.assign(new Error('Translation to Hindi requires cloud AI and is unavailable in High-Privacy Mode.'), { status: 422 });
  const source = sourceOf(doc.extraction || {}, to);
  const base = { language: to, basedOn: (doc.audit || []).length, createdAt: now.toISOString() };
  if (!isPrivacyMode() && isAiConfigured()) {
    try {
      const result = await generateStructured({
        parts: [{ text: prompt(source, to) }], schema: SCHEMA, deadline: Date.now() + AI_BUDGET_MS, tag: 'Translate',
        parse: text => parseAnswer(text, source),
      });
      const { model, ...rest } = result;
      return { ...base, method: 'ai', model, ...(to === 'en' ? latinOnly(rest) : rest) };
    } catch (err) {
      console.error('[Translate] AI translation failed:', err.code || err.status || '', err.message);
    }
  }
  if (to !== 'en') {
    throw Object.assign(new Error('Translation to Hindi needs the AI service, which is not available right now. Please try again later.'), { status: 503 });
  }
  return { ...base, method: 'transliteration', ...transliterated(source) };
}
