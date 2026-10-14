/**
 * Human review of an extraction, with an append-only audit trail.
 *
 * Field actions:
 *   confirm  the extracted value is right            → confidence 1.0
 *   correct  replace the value (null: not in the doc) → confidence 1.0 (0 when null)
 *   reset    back to the value the AI extracted       → its original confidence
 * Document actions:
 *   approve  the reviewer signs the document off (open errors are recorded)
 *   reopen   back to review
 *
 * After every field action the document is validated again: the rule issues
 * are rebuilt from the new values, the validation part of each AI-scored
 * field's confidence is recomputed from the stored parts (same weights and
 * caps as confidence.js), and the overall confidence follows. Reviewed
 * fields keep 1.0: a person checked them against the document.
 *
 * Audit entries: { at, by, action, fieldKey?, label?, from?, to?, note?,
 *                  issuesBefore, issuesAfter, overallBefore, overallAfter }.
 * Pure functions; routes/review.js stores the result.
 */
import { HALLUCINATION_CAP, OCR_CAP, WEIGHTS, confidenceBand, overallConfidence, validationScore } from './confidence.js';
import { QUALITY_CAP } from './quality.js';
import { cleanValue, normalizeValue } from './normalize.js';
import { getDocType } from './schemas.js';
import { lowConfidenceIssues, sortIssues, validateExtraction } from './validate.js';
import { ocrValidationInput, validateOcrFields, ocrValidationIssues } from './ocr/validation.js';

export const FIELD_ACTIONS = ['confirm', 'correct', 'reset'];
export const DOCUMENT_ACTIONS = ['approve', 'reopen'];
const MAX_NOTE = 300;
const MAX_VALUE = 500;
const round2 = n => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });
function issueCounts(issues = []) {
  const counts = { error: 0, warning: 0, info: 0, total: issues.length };
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return counts;
}

/** Confidence of an AI-scored field with its validation part recomputed. */
function rescore(field, issues) {
  const d = field.confidenceDetail;
  if (field.value == null || !d) return field;
  const validation = validationScore(field, issues);
  let c = WEIGHTS.model * d.model + WEIGHTS.verification * d.verification + WEIGHTS.validation * validation;
  if (d.capped?.includes('ocr')) c = Math.min(c, OCR_CAP);
  if (d.capped?.includes('image_quality')) c = Math.min(c, QUALITY_CAP);
  if (d.capped?.includes('unverified')) c = Math.min(c, HALLUCINATION_CAP);
  const confidence = round2(c);
  return { ...field, confidence: field.ocr ? field.ocr.confidence : confidence,
    confidenceBand: confidenceBand(field.ocr ? field.ocr.confidence : confidence),
    ...(field.ocr ? { extractionConfidence: confidence } : {}), confidenceDetail: { ...d, validation: round2(validation) } };
}

const isReviewed = f => f.review && f.review.status !== 'reset';

/** Validate again after a change and recompute the confidences. */
export function revalidate(extraction, { now = new Date() } = {}) {
  const textByPage = extraction.rawTextByPage || [];
  // Image-quality issues come from the upload, not from the values: they stay.
  const ruleIssues = [...validateExtraction(ocrValidationInput(extraction), { now, textByPage }), ...(extraction.issues || []).filter(i => i.type === 'quality')];
  const fields = extraction.fields.map(f => (isReviewed(f)
    ? { ...f, confidence: f.value == null ? 0 : 1, confidenceBand: f.value == null ? 'low' : 'high' }
    : rescore(f, ruleIssues)));
  const validated = validateOcrFields({ ...extraction, fields }, ruleIssues);
  const issues = sortIssues([...ruleIssues, ...ocrValidationIssues(validated.fields, ruleIssues), ...lowConfidenceIssues(validated.fields)]);
  return { ...validated, issues, overallConfidence: overallConfidence(validated.fields, issues) };
}

/**
 * The extraction as the AI produced it: every reviewed field back to its
 * original value, no review status. Used when a cached extraction is copied
 * for another owner, whose copy must not carry someone else's review.
 */
export function withoutReview(extraction) {
  if (!extraction?.review && !(extraction?.fields || []).some(f => f.review)) return extraction;
  const fields = extraction.fields.map(f => {
    if (!f.review) return f;
    const { review, ...rest } = f;
    return { ...rest, ...review.original };
  });
  const { review, ...rest } = extraction;
  return revalidate({ ...rest, fields });
}

/** Review progress of an extraction: { status, reviewed, total, approvedAt?, approvedBy? }. */
export function reviewSummary(extraction) {
  const fields = (extraction.fields || []).filter(f => f.value != null || f.required || f.status === 'needs_review');
  const reviewed = fields.filter(isReviewed).length;
  const prev = extraction.review || {};
  const status = prev.status === 'approved' ? 'approved' : reviewed ? 'in_review' : 'unreviewed';
  return { ...prev, status, reviewed, total: fields.length };
}

function entry(extraction, after, base) {
  return {
    ...base,
    issuesBefore: issueCounts(extraction.issues),
    issuesAfter: issueCounts(after.issues),
    overallBefore: extraction.overallConfidence ?? null,
    overallAfter: after.overallConfidence ?? null,
  };
}

/**
 * Apply one field action. Returns { extraction, audit } (audit: the entry to
 * append). Throws { status: 400 | 404 } for a bad request.
 */
export function reviewField(extraction, fieldKey, { action, value, note } = {}, { by, now = new Date() }) {
  if (!FIELD_ACTIONS.includes(action)) throw fail(400, `Action must be one of: ${FIELD_ACTIONS.join(', ')}.`);
  const index = extraction.fields.findIndex(f => f.key === fieldKey);
  if (index < 0) throw fail(404, 'Field not found.');
  const field = extraction.fields[index];
  const at = now.toISOString();
  const cleanNote = note == null ? null : String(note).trim().slice(0, MAX_NOTE) || null;
  // The AI's own answer, kept on the first change so it can be restored.
  const original = field.review?.original ?? { value: field.value, normalizedValue: field.normalizedValue, confidence: field.confidence,
    confidenceBand: field.confidenceBand, page: field.page, sourceQuote: field.sourceQuote,
    ...(field.box ? { box: field.box } : {}), ...(field.status ? { status: field.status, ocr: structuredClone(field.ocr), steps_applied: [...(field.steps_applied || [])] } : {}) };

  let next;
  if (action === 'confirm') {
    if (field.value == null) throw fail(400, 'There is no value to confirm; correct it instead.');
    next = { ...field, review: { status: 'confirmed', by, at, original } };
  } else if (action === 'correct') {
    if (value !== null && typeof value !== 'string') throw fail(400, 'Send the corrected value as text (or null when it is not in the document).');
    const v = value === null ? null : cleanValue(value, MAX_VALUE);
    if (v === field.value && field.status !== 'needs_review') throw fail(400, 'The value is unchanged; confirm it instead.');
    const def = getDocType(extraction.docType).fields.find(d => d.key === field.key) || {};
    // The quote and box located the old value; a corrected value has no machine source.
    const { box, ...rest } = field;
    next = { ...rest, value: v, normalizedValue: normalizeValue({ ...def, ...field }, v, null),
      sourceQuote: v === original.value ? original.sourceQuote : null,
      review: { status: 'corrected', by, at, original } };
  } else {
    if (!field.review) throw fail(400, 'This field has not been reviewed.');
    const { review, ...rest } = field;
    next = { ...rest, ...review.original };
  }
  if (action !== 'reset' && field.ocr) {
    next.status = 'accepted';
    next.ocr = { ...next.ocr, manualReview: { by, at, action } };
    next.steps_applied = [...new Set([...(next.steps_applied || []), 'manual_review'])];
  }
  const fields = extraction.fields.map((f, i) => (i === index ? next : f));
  const after = revalidate({ ...extraction, fields }, { now });
  // Any change after approval needs a new approval.
  const wasApproved = extraction.review?.status === 'approved';
  after.review = reviewSummary({ ...after, review: {} });
  const audit = entry(extraction, after, {
    at, by, action, fieldKey: field.key, label: field.label,
    from: field.value, to: next.value, ...(cleanNote ? { note: cleanNote } : {}), ...(wasApproved ? { approvalWithdrawn: true } : {}),
  });
  return { extraction: after, audit };
}

/** Approve or reopen a document. Returns { extraction, audit }. */
export function reviewDocument(extraction, { action, note } = {}, { by, now = new Date() }) {
  if (!DOCUMENT_ACTIONS.includes(action)) throw fail(400, `Action must be one of: ${DOCUMENT_ACTIONS.join(', ')}.`);
  const at = now.toISOString();
  const current = reviewSummary(extraction);
  if (action === 'approve' && current.status === 'approved') throw fail(400, 'The document is already approved.');
  if (action === 'reopen' && current.status !== 'approved') throw fail(400, 'Only an approved document can be reopened.');
  const after = { ...extraction, review: action === 'approve'
    ? { ...current, status: 'approved', approvedAt: at, approvedBy: by }
    : reviewSummary({ ...extraction, review: {} }) };
  const cleanNote = note == null ? null : String(note).trim().slice(0, MAX_NOTE) || null;
  return { extraction: after, audit: entry(extraction, after, { at, by, action, ...(cleanNote ? { note: cleanNote } : {}) }) };
}
