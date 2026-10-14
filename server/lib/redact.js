/**
 * PII masking of a document response (GET /api/documents/:id?redact=1 and
 * the redacted JSON / CSV exports). Pure functions.
 *
 * Fields:
 *   names of people (student, holder, parents …)   Asha Verma        → A. V.
 *   personal numbers (roll, ID, Aadhaar …)          2345 6789 0124    → XXXX XXXX 0124
 *   PAN / GSTIN of an individual (4th PAN letter P) ABCPE1234F        → XXXXXX234F
 *   date of birth                                    14/03/2006        → XX/XX/2006
 *   email, phone                                     asha@example.com  → a***@example.com
 *   personal address, PIN code                       18 Demo Nagar …   → [address withheld]; 302004 → 302XXX
 * Business data (seller, buyer, GSTIN / PAN of a company, amounts) stays.
 *
 * Free text (title, summary, source quotes, entities, tables, issues, the
 * review trail) gets every masked value replaced, and a pattern sweep for
 * e-mails, Indian mobile numbers, Aadhaar numbers and individual PANs.
 */
import { asciiDigits } from './normalize.js';

const NAME_KEYS = new Set(['student_name', 'recipient_name', 'applicant_name', 'holder_name', 'father_or_guardian_name', 'mother_name', 'addressed_to', 'name', 'full_name', 'person_name', 'author', 'author_name']);
const ID_KEYS = new Set(['roll_number', 'enrollment_number', 'application_number', 'id_number', 'certificate_number']);
const ADDRESS_KEYS = new Set(['address']);

export const PII_KINDS = {
  name: 'Names of people',
  id: 'Personal ID numbers (roll, enrollment, ID / Aadhaar, certificate)',
  pan: 'PAN / GSTIN of an individual',
  dob: 'Date of birth',
  email: 'E-mail addresses',
  phone: 'Phone numbers',
  address: 'Personal addresses and PIN codes',
  bank: 'Bank account numbers',
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Words of a value may be joined by spaces, dashes, dots or underscores ("asha-verma.pdf").
const SEPARATORS = /[\s_.-]+/g;
const normalized = s => s.toLowerCase().replace(SEPARATORS, ' ');

/** Every letter or digit but the last `keep` becomes X (separators stay). */
export function maskKeepLast(value, keep = 4) {
  const s = asciiDigits(value);
  let left = s.replace(/[^A-Za-z0-9]/g, '').length - keep;
  return s.replace(/[A-Za-z0-9]/g, c => (left-- > 0 ? 'X' : c));
}

export const maskName = value => String(value).trim().split(/\s+/)
  .filter(w => !/^(mr|mrs|ms|dr|shri|smt|kumari|km|sri)\.?$/i.test(w))
  .map(w => `${[...w][0].toUpperCase()}.`).join(' ');

export function maskEmail(value) {
  const [user, domain] = String(value).split('@');
  return domain ? `${user[0]}***@${domain}` : maskKeepLast(value, 2);
}

/** Keep the year: 14/03/2006 → XX/XX/2006, 14 March 2006 → XX XXX 2006. */
export function maskDate(value) {
  const s = asciiDigits(value);
  const year = (s.match(/\b(19|20)\d{2}\b/) || [])[0];
  return s.replace(/\d+/g, m => (m === year ? m : 'X'.repeat(m.length))).replace(/\b[A-Za-zऀ-ॿ]{3,}\b/g, 'XXX');
}

const isIndividualPan = v => /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/.test(v);
const panIn = v => (asciiDigits(v).toUpperCase().replace(/[\s-]/g, '').match(/[A-Z]{5}\d{4}[A-Z]/) || [])[0] || '';

/** ?redact=1 (or true / yes) on a request. */
export const wantsRedaction = query => /^(1|true|yes)$/i.test(String(query?.redact || ''));

/** How a field is masked: { kind, masked } or null when it is not personal data. */
export function maskField(field) {
  if (field.value == null) return null;
  const v = String(field.value);
  if (NAME_KEYS.has(field.key)) return { kind: 'name', masked: maskName(v) };
  if (field.key === 'date_of_birth') return { kind: 'dob', masked: maskDate(v) };
  if (field.type === 'email' || field.key === 'email') return { kind: 'email', masked: maskEmail(v) };
  if (field.type === 'phone' || field.key === 'phone') return { kind: 'phone', masked: maskKeepLast(v, 4) };
  if (ADDRESS_KEYS.has(field.key)) return { kind: 'address', masked: '[address withheld]' };
  if (field.format === 'pincode' || field.key === 'pincode') return { kind: 'address', masked: v.replace(/(\d{3})\d{3}/, '$1XXX') };
  if (field.format === 'pan' || field.format === 'gstin') return isIndividualPan(panIn(v)) ? { kind: 'pan', masked: maskKeepLast(v, 4) } : null;
  if (field.key === 'bank_account_number') return { kind: 'bank', masked: maskKeepLast(v, 4) };
  if (ID_KEYS.has(field.key)) return { kind: 'id', masked: maskKeepLast(v, field.key === 'id_number' ? 4 : 3) };
  return null;
}

// Patterns swept from all free text, whatever field they came from.
const SWEEPS = [
  [/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi, maskEmail],
  [/\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, v => maskKeepLast(v, 4)], // Aadhaar
  [/(?:\+91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, v => maskKeepLast(v, 4)], // mobile
  [/\b[A-Z]{3}P[A-Z]\d{4}[A-Z]\b/g, v => maskKeepLast(v, 4)], // individual PAN
  [/\b\d{2}[A-Z]{3}P[A-Z]\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, v => maskKeepLast(v, 4)], // GSTIN of an individual
];

/** A function that masks a piece of free text with the given replacements. */
function textMasker(replacements) {
  // Longest first, so "Asha Verma" goes before "Asha".
  const pairs = [...replacements].filter(([from]) => from && from.length >= 3).sort((a, b) => b[0].length - a[0].length);
  const re = pairs.length ? new RegExp(pairs.map(([from]) => escapeRe(from).replace(/\s+/g, '[\\s_.-]+')).join('|'), 'giu') : null;
  const lookup = new Map(pairs.map(([from, to]) => [normalized(from), to]));
  return text => {
    if (text == null || typeof text !== 'string') return text;
    let s = re ? text.replace(re, m => lookup.get(normalized(m)) ?? m) : text;
    for (const [pattern, mask] of SWEEPS) s = s.replace(pattern, mask);
    return s;
  };
}

/** Add the personal values of one document's fields and entities to `replacements`. */
function collect(replacements, fields = [], entities = []) {
  for (const f of fields) {
    // OCR candidates may contain personal values while the field is withheld.
    for (const candidate of f.candidates || []) {
      if (candidate.value == null) continue;
      const masked = maskField({ ...f, value: candidate.value });
      if (masked) {
        replacements.set(String(candidate.value), masked.masked);
        replacements.set(asciiDigits(String(candidate.value)), masked.masked);
      }
    }
    const m = maskField(f);
    if (!m) continue;
    replacements.set(String(f.value), m.masked);
    // The same value as written elsewhere (normalised forms, the name in capitals).
    if (typeof f.normalizedValue === 'string' && f.normalizedValue !== f.value) {
      replacements.set(f.normalizedValue, m.kind === 'dob' ? maskDate(f.normalizedValue) : m.masked);
    }
    if (f.review?.original?.value) replacements.set(String(f.review.original.value), maskField({ ...f, value: f.review.original.value })?.masked || m.masked);
  }
  // People named only in the entities are masked too.
  for (const e of entities) {
    if (e.type === 'PERSON' && e.value && !replacements.has(e.value)) replacements.set(e.value, maskName(e.value));
  }
  return replacements;
}

// In file names, initials without dots or spaces: asha-verma.pdf → AV.pdf.
const filenameMasker = replacements => textMasker(new Map([...replacements].map(([from, to]) => [from, to.replace(/\.\s*/g, '').replace(/\s+/g, '_')])));

/**
 * Maskers for text that mentions several documents (cross-document issues,
 * the entity graph): { text, filename }. docs: stored records or responses.
 */
export function maskerFor(docs) {
  const replacements = new Map();
  for (const d of docs) collect(replacements, d.extraction?.fields || d.fields, d.extraction?.entities || d.entities);
  return { text: textMasker(replacements), filename: filenameMasker(replacements) };
}

/**
 * Masked copy of a document response (toDocumentResponse). Adds
 * `redacted: true` and `redaction: { fields: [{ key, label, kind }], kinds }`.
 */
export function redactDocument(doc) {
  const replacements = collect(new Map(), doc.fields || [], doc.entities || []);
  const maskedFields = [];
  const fields = (doc.fields || []).map(f => {
    const m = maskField(f);
    if (!m) return f;
    maskedFields.push({ key: f.key, label: f.label, kind: m.kind });
    const { transliteration, ...rest } = f;
    return { ...rest, value: m.masked, normalizedValue: m.masked, masked: true };
  });
  const mask = textMasker(replacements);
  const maskFilename = filenameMasker(replacements);
  const byKey = new Map((doc.fields || []).map(f => [f.key, f]));
  // A value in the review trail, masked like its field (an earlier value is no longer in the text).
  const maskTrail = (key, v) => {
    if (v == null) return v;
    const f = byKey.get(key);
    return (f && maskField({ ...f, value: v })?.masked) || mask(v);
  };
  const maskDeep = v => (typeof v === 'string' ? mask(v) : Array.isArray(v) ? v.map(maskDeep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([key, value]) => [key, maskDeep(value)])) : v);
  const maskCandidates = f => (f.candidates || []).map(c => ({ ...maskDeep(c),
    ...(maskField({ ...f, value: c.value }) ? { lowConfidenceTokens: [] } : {}) }));

  return {
    ...doc,
    filename: maskFilename(doc.filename),
    title: mask(doc.title),
    summary: mask(doc.summary),
    fields: fields.map(f => ({
      ...f,
      ...(f.candidates ? { candidates: maskCandidates(f) } : {}),
      ...(f.ocr ? { ocr: maskDeep(f.ocr) } : {}),
      sourceQuote: mask(f.sourceQuote),
      ...(f.masked ? {} : { value: mask(f.value), normalizedValue: maskDeep(f.normalizedValue), transliteration: mask(f.transliteration) }),
      // The AI's own answer kept by a review: every text in it (value, normalised value, quote).
      ...(f.review ? { review: { ...f.review, by: maskEmail(f.review.by),
        original: Object.fromEntries(Object.entries(f.review.original || {}).map(([k, v]) => [k, maskDeep(v)])) } } : {}),
    })),
    entities: (doc.entities || []).map(e => ({ ...e, value: mask(e.value), sourceQuote: mask(e.sourceQuote) })),
    tables: (doc.tables || []).map(t => ({ ...t, title: mask(t.title), columns: maskDeep(t.columns), rows: maskDeep(t.rows) })),
    issues: (doc.issues || []).map(i => ({ ...i, message: mask(i.message) })),
    review: doc.review ? { ...doc.review, approvedBy: doc.review.approvedBy ? maskEmail(doc.review.approvedBy) : doc.review.approvedBy } : doc.review,
    audit: (doc.audit || []).map(a => ({ ...a, by: maskEmail(a.by), from: maskTrail(a.fieldKey, a.from), to: maskTrail(a.fieldKey, a.to), note: mask(a.note) })),
    // Translations name people in another script; they are not shown while masking.
    translations: {},
    ...(doc.rawTextByPage ? { rawTextByPage: maskDeep(doc.rawTextByPage) } : {}),
    ...(doc.textByPage ? { textByPage: maskDeep(doc.textByPage) } : {}),
    ...(doc.needs_review ? { needs_review: doc.needs_review.map(item => ({ ...maskDeep(item), candidates: maskCandidates(byKey.get(item.field) || { candidates: item.candidates }) })) } : {}),
    redacted: true,
    redaction: {
      fields: maskedFields,
      kinds: Object.fromEntries([...new Set(maskedFields.map(f => f.kind))].map(k => [k, PII_KINDS[k]])),
    },
  };
}

/** Cross-document issues with the personal data of all the owner's documents masked. */
export function redactCrossIssues(issues, docs) {
  const m = maskerFor(docs);
  return issues.map(i => ({
    ...i,
    message: m.text(i.message),
    refs: i.refs.map(r => ({ ...r, title: m.text(r.title), filename: m.filename(r.filename),
      value: r.value == null ? r.value : maskField({ key: r.fieldKey, value: r.value })?.masked ?? m.text(r.value) })),
  }));
}

/** An entity graph (entityGraph.js) with personal data masked. */
export function redactEntityGraph(graph, docs) {
  const m = maskerFor(docs);
  return {
    ...graph,
    nodes: graph.nodes.map(n => ({ ...n, label: m.text(n.label), desc: m.text(n.desc) })),
    edges: graph.edges.map(e => (e.message ? { ...e, message: m.text(e.message) } : e)),
    issues: redactCrossIssues(graph.issues || [], docs),
    redacted: true,
  };
}
