/**
 * Confidence scoring for extracted values.
 *
 *   confidence = 0.5 × model confidence
 *              + 0.3 × source verification   (is the quote really in the document,
 *                                              and does it contain the value?)
 *              + 0.2 × validation            (format / consistency checks)
 *
 * then clamped to 0–1 and rounded to 2 decimals, with two caps:
 *  - OCR cap (0.90): values read from scans/photos can only be checked against the
 *    model's own transcription, never an independent text layer;
 *  - hallucination cap (0.40): a document with a text layer where neither the quote
 *    nor the value can be found anywhere;
 *  - image-quality cap (0.75): OCR values from a blurry, dark or washed-out image (quality.js).
 * Missing values (null) always score 0.
 *
 * Bands: high ≥ 0.80, medium 0.50–0.79, low < 0.50.
 */
import { asciiDigits, matchesFormat, parseAmount, parseDate } from './normalize.js';
import { SCANNED_CHARS_PER_PAGE } from './pdfText.js';
import { QUALITY_CAP } from './quality.js';

export const WEIGHTS = { model: 0.5, verification: 0.3, validation: 0.2 };
export const OCR_CAP = 0.9;
export const HALLUCINATION_CAP = 0.4;
export const BANDS = { high: 0.8, medium: 0.5 };
// Overall confidence penalty per issue (low_confidence issues are informational).
export const ISSUE_PENALTY = { error: 0.05, warning: 0.02, info: 0 };

const round2 = n => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;

export function confidenceBand(c) {
  if (c >= BANDS.high) return 'high';
  if (c >= BANDS.medium) return 'medium';
  return 'low';
}

/** Text compared loosely: case, accents, punctuation and spacing are ignored; Devanagari kept. */
export function looseText(s) {
  return asciiDigits(String(s ?? ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1') // 1,18,000 -> 118000
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

const tokens = s => looseText(s).split(' ').filter(t => t.length > 0);

/** Share of `needle` tokens that occur in `haystack` (0–1). */
function tokenCoverage(needle, haystack) {
  const n = tokens(needle);
  if (!n.length) return 0;
  const h = new Set(tokens(haystack));
  return n.filter(t => h.has(t)).length / n.length;
}

/** Numbers in a text, for amount/number comparisons ("Rs. 1,180.00" -> [1180]). */
function numbersIn(s) {
  return (asciiDigits(String(s ?? '')).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => Number(x.replace(/,/g, ''))).filter(Number.isFinite);
}

/** How well the value is supported by its quote (0–1). */
export function valueInQuote(field, quote) {
  if (field.value == null || !quote) return 0;
  const lq = looseText(quote);
  const lv = looseText(field.value);
  if (lv && ` ${lq} `.includes(` ${lv} `)) return 1;
  if (lv && lq.includes(lv)) return 0.9;
  // Symbol-only values such as "₹" have no letters or digits to compare.
  if (!lv && String(quote).includes(String(field.value).trim())) return 1;
  const norm = field.normalizedValue;
  if ((field.type === 'amount' || field.type === 'number') && typeof norm === 'number') {
    if (numbersIn(quote).some(n => Math.abs(n - norm) < 0.005)) return 1;
  }
  if (field.type === 'date' && norm) {
    // The quote may write the same date differently.
    const candidates = String(quote).match(/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}\s+\S+\s+\d{4}/g) || [];
    if (candidates.some(c => parseDate(c) === norm)) return 1;
  }
  if (field.type === 'id' && norm) {
    if (looseText(quote).replace(/ /g, '').includes(String(norm).toLowerCase())) return 1;
  }
  return Math.round(tokenCoverage(field.value, quote) * 0.8 * 100) / 100;
}

/** Where a quote occurs in the page texts: 1 on the cited page, 0.85 elsewhere, partial by tokens, 0 if absent. */
export function quoteInText(quote, page, textByPage) {
  if (!quote || !textByPage?.length) return 0;
  const lq = looseText(quote.replace(/…$/, ''));
  if (!lq) return 0;
  const pages = textByPage.map(looseText);
  const cited = page && pages[page - 1];
  if (cited && cited.includes(lq)) return 1;
  if (pages.some(p => p.includes(lq))) return 0.85;
  // Tolerate small OCR / extraction differences in words, but every number
  // in the quote must really be on the page.
  const numeric = tokens(quote).filter(t => /\d/.test(t));
  const best = Math.max(...pages.map((p, i) => {
    const pageTokens = new Set(p.split(' '));
    if (numeric.some(t => !pageTokens.has(t))) return 0;
    return tokenCoverage(quote, textByPage[i]);
  }));
  return best >= 0.7 ? Math.round(best * 0.7 * 100) / 100 : 0;
}

const valueInText = (value, textByPage) => {
  const lv = looseText(value);
  return Boolean(lv) && textByPage.some(t => looseText(t).includes(lv));
};

/** Where a page's text came from: its own text layer, or OCR (model transcription / none). */
function pageSource(page, { ocrUsed, textLayerPages }) {
  if (!ocrUsed) return 'text_layer';
  return page && textLayerPages?.[page - 1] ? 'text_layer' : 'ocr';
}

/** Validation score from the field's own format checks and the issues that mention it. */
export function validationScore(field, issues = []) {
  if (field.value == null) return 0;
  let score = 1;
  const parsed =
    field.type === 'date' ? field.normalizedValue != null
    : field.type === 'amount' || field.type === 'number' ? typeof field.normalizedValue === 'number' || parseAmount(field.value) != null
    : field.type === 'email' ? field.normalizedValue != null
    : true;
  if (!parsed || !matchesFormat(field, field.normalizedValue)) score = 0;
  for (const issue of issues) {
    if (issue.type === 'low_confidence' || !issue.fieldKeys?.includes(field.key)) continue;
    score = Math.min(score, issue.severity === 'error' ? 0 : issue.severity === 'warning' ? 0.5 : 0.8);
  }
  return score;
}

/**
 * Score one field (or entity: pass type 'string'). Returns the final
 * confidence, its band and the parts that produced it.
 */
export function scoreField(field, ctx) {
  const { textByPage = [], issues = [] } = ctx;
  if (field.value == null) {
    return { confidence: 0, confidenceBand: 'low', confidenceDetail: { model: 0, verification: 0, validation: 0, source: null } };
  }
  const model = Math.min(1, Math.max(0, Number(field.modelConfidence ?? field.confidence ?? 0.5)));
  const source = pageSource(field.page, ctx);
  const hasText = textByPage.some(t => String(t || '').trim());

  const quoteFound = hasText ? quoteInText(field.sourceQuote, field.page, textByPage) : 0;
  const supportsValue = valueInQuote(field, field.sourceQuote);
  // A quote that is not in the text cannot vouch for the value.
  const verification = hasText ? quoteFound * (0.6 + 0.4 * supportsValue) : 0.5 * supportsValue;
  const validation = validationScore(field, issues);

  let confidence = WEIGHTS.model * model + WEIGHTS.verification * verification + WEIGHTS.validation * validation;
  const caps = [];
  if (source === 'ocr' && confidence > OCR_CAP) {
    confidence = OCR_CAP;
    caps.push('ocr');
  }
  if (source === 'ocr' && ctx.poorImage && confidence > QUALITY_CAP) {
    confidence = QUALITY_CAP;
    caps.push('image_quality');
  }
  const hallucinated = source === 'text_layer' && hasText && quoteFound === 0 && !valueInText(field.value, textByPage);
  if (hallucinated && confidence > HALLUCINATION_CAP) {
    confidence = HALLUCINATION_CAP;
    caps.push('unverified');
  }
  confidence = round2(confidence);
  return {
    confidence,
    confidenceBand: confidenceBand(confidence),
    confidenceDetail: {
      model: round2(model),
      verification: round2(verification),
      validation: round2(validation),
      quoteFound: quoteFound > 0,
      source,
      ...(caps.length ? { capped: caps } : {}),
    },
  };
}

/**
 * Overall document confidence: mean confidence of the required fields
 * (or of all found fields when the type has no required ones), minus a
 * penalty per issue (error 0.05, warning 0.02).
 */
export function overallConfidence(fields, issues = []) {
  const required = fields.filter(f => f.required);
  const basis = required.length ? required : fields.filter(f => f.value != null);
  const mean = basis.length ? basis.reduce((s, f) => s + (f.confidence || 0), 0) / basis.length : 0;
  const penalty = issues.reduce((s, i) => s + (ISSUE_PENALTY[i.severity] || 0), 0);
  return round2(mean - penalty);
}

/**
 * Pages whose text is an independent PDF text layer (true) rather than OCR
 * (false). For a digital PDF every page is true; for an image or scanned PDF
 * every page is false; mixed PDFs depend on the page. Pages with a garbled
 * text layer count as OCR.
 */
export function textLayerPagesFor(pagesFromPdf, pageCount, ocrUsed, unreliablePages = []) {
  return Array.from({ length: pageCount || 1 }, (_, i) => !unreliablePages.includes(i + 1) &&
    (String(pagesFromPdf?.[i] || '').replace(/\s/g, '').length >= SCANNED_CHARS_PER_PAGE || (!ocrUsed && Boolean(pagesFromPdf?.length))));
}

/**
 * Score every field and entity of an extraction.
 * ctx: { textByPage, ocrUsed, textLayerPages, issues }. Returns a new extraction.
 */
export function scoreExtraction(extraction, { textByPage = [], ocrUsed = false, textLayerPages, issues = [], poorImage = false } = {}) {
  const ctx = { textByPage, ocrUsed, textLayerPages: textLayerPages || textByPage.map(() => !ocrUsed), issues, poorImage };
  const fields = extraction.fields.map(f => ({ ...f, ...scoreField(f, ctx) }));
  const entities = extraction.entities.map(e => {
    // Entities carry no model confidence: a neutral 0.8, then the same checks.
    const s = scoreField({ ...e, type: 'string', modelConfidence: 0.8 }, { ...ctx, issues: [] });
    return { ...e, confidence: s.confidence, confidenceBand: s.confidenceBand };
  });
  return { ...extraction, fields, entities };
}
