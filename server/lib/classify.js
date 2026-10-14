/**
 * Document classification: category → type → subtype, top-3 type candidates
 * and one consistent type confidence.
 *
 * The model's own confidence is often 1.0 for everything, so the confidence
 * shown is calibrated on the server from three kinds of evidence:
 *   p(type)    = 0.8 × model candidates + 0.2 × keyword evidence in the text
 *                (model only when the text has no type keywords)
 *   confidence = p(chosen type) × (0.6 + 0.4 × share of its required fields found)
 * The candidates are the top 3 of p, with the chosen type at its calibrated
 * confidence, so the badge, the candidate list and the issues always agree.
 */
import { DOCUMENT_TYPES, DOC_TYPE_IDS, getDocType } from './schemas.js';

export const MODEL_WEIGHT = 0.8;
export const KEYWORD_WEIGHT = 0.2;
// A second candidate at least this likely is reported as an ambiguity.
export const AMBIGUOUS_AT = 0.25;

const round2 = n => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keywordRe = new Map();
/** Latin keywords match whole words ("sac" not inside "transaction"); Hindi ones as written. */
function contains(lower, keyword) {
  if (/[\u0900-\u097F]/.test(keyword)) return lower.includes(keyword);
  if (!keywordRe.has(keyword)) keywordRe.set(keyword, new RegExp(`(^|[^a-z0-9])${escapeRe(keyword)}($|[^a-z0-9])`));
  return keywordRe.get(keyword).test(lower);
}

function keywordHits(lower, keywords) {
  let score = 0;
  for (const k of keywords) {
    const kk = k.toLowerCase();
    if (contains(lower, kk)) score += kk.includes(' ') ? 2 : 1;
  }
  return score;
}

/** Share of the type keywords found in the text, per type (null when none match). */
export function keywordDistribution(text) {
  const lower = String(text || '').toLowerCase();
  const scores = {};
  let total = 0;
  for (const t of DOCUMENT_TYPES) {
    const s = keywordHits(lower, t.keywords || []);
    if (s) {
      scores[t.id] = s;
      total += s;
    }
  }
  if (!total) return null;
  return Object.fromEntries(Object.entries(scores).map(([id, s]) => [id, s / total]));
}

/** The subtype whose keywords match best (at least one hit), or null. */
export function guessSubtype(docType, text) {
  const lower = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const s of getDocType(docType).subtypes || []) {
    const score = keywordHits(lower, s.keywords);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Calibrate the classification of an extraction. Returns a new extraction with
 * docTypeConfidence (calibrated), typeCandidates (top 3), docCategory,
 * docSubtype / docSubtypeLabel and classification (the evidence used).
 */
export function calibrateClassification(extraction, { textByPage = [] } = {}) {
  const chosen = DOC_TYPE_IDS.includes(extraction.docType) ? extraction.docType : 'other';
  const type = getDocType(chosen);
  const modelConfidence = Number.isFinite(extraction.docTypeConfidence) ? extraction.docTypeConfidence : 0.5;

  // The model's distribution: its candidates, the chosen type at its confidence, the rest "other".
  const model = {};
  for (const c of extraction.typeCandidates || []) model[c.docType] = Math.max(model[c.docType] || 0, c.confidence || 0);
  model[chosen] = Math.max(model[chosen] || 0, modelConfidence);
  let sum = Object.values(model).reduce((a, b) => a + b, 0);
  if (sum > 1) {
    for (const k of Object.keys(model)) model[k] /= sum;
    sum = 1;
  }
  // Unknown probability is not evidence that an unrecognised document is
  // certainly "other". Preserve the supplied confidence for that choice.
  if (sum < 1 && chosen !== 'other') model.other = (model.other || 0) + (1 - sum);

  const text = textByPage.join('\n');
  const keywords = keywordDistribution(text);
  const p = Object.fromEntries(DOC_TYPE_IDS.map(id => [
    id, keywords ? MODEL_WEIGHT * (model[id] || 0) + KEYWORD_WEIGHT * (keywords[id] || 0) : model[id] || 0,
  ]));

  const required = extraction.fields.filter(f => f.required && !f.extra);
  const coverage = required.length ? required.filter(f => f.value != null).length / required.length : 1;
  const confidence = round2(p[chosen] * (0.6 + 0.4 * coverage));

  let candidates = DOC_TYPE_IDS
    .map(id => ({ docType: id, label: getDocType(id).label, confidence: id === chosen ? confidence : round2(p[id]) }))
    .filter(c => c.confidence > 0 || c.docType === chosen)
    .sort((a, b) => b.confidence - a.confidence);
  if (candidates.findIndex(c => c.docType === chosen) > 2) {
    candidates = [candidates.find(c => c.docType === chosen), ...candidates.filter(c => c.docType !== chosen)];
  }
  candidates = candidates.slice(0, 3);

  const fromModel = (type.subtypes || []).find(s => s.id === extraction.docSubtype);
  const subtype = fromModel || guessSubtype(chosen, text);

  return {
    ...extraction,
    docType: chosen,
    docTypeConfidence: confidence,
    docCategory: type.category || 'General',
    docSubtype: subtype?.id || null,
    docSubtypeLabel: subtype?.label || null,
    typeCandidates: candidates,
    classification: {
      modelConfidence: round2(modelConfidence),
      keywordShare: keywords ? round2(keywords[chosen] || 0) : null,
      requiredCoverage: round2(coverage),
      subtypeFrom: fromModel ? 'model' : subtype ? 'keywords' : null,
    },
  };
}
