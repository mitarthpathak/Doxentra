/** Public shapes of saved document extractions (API responses and exports). */
import { reviewSummary } from './review.js';
import { redactDocument } from './redact.js';
import { hasDevanagari, transliterate } from './translit.js';
import { applyFieldPolicy } from './fieldPolicy.js';
import { needsReview } from './ocr/state.js';

/** A Hindi value in Latin letters, so it can be read (and checked) without Hindi. */
const withTransliteration = f => (typeof f.value === 'string' && hasDevanagari(f.value)
  ? { ...f, transliteration: transliterate(f.value, { capitalize: /name/.test(f.key) }) }
  : f);

// Audit entries sent with a document (all of them: GET /api/documents/:id/audit).
const AUDIT_IN_RESPONSE = 50;

export function issueCounts(issues = []) {
  const counts = { error: 0, warning: 0, info: 0, total: issues.length };
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return counts;
}

/** Full document as returned by /api/extract and GET /api/documents/:id. */
export function toDocumentResponse(doc, extra = {}) {
  const x = applyFieldPolicy(doc.extraction || {});
  return {
    success: true,
    id: String(doc._id),
    filename: doc.filename,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    createdAt: doc.createdAt,
    fallbackUsed: doc.source === 'fallback',
    processingMode: doc.processingMode || 'deep',
    ...(doc.processingMode === 'privacy' ? { textByPage: x.rawTextByPage || [] } : {}),
    ...(doc.warning ? { warning: doc.warning } : {}),
    model: doc.model,
    docType: x.docType,
    docTypeLabel: x.docTypeLabel,
    docTypeConfidence: x.docTypeConfidence,
    docCategory: x.docCategory || null,
    docSubtype: x.docSubtype || null,
    docSubtypeLabel: x.docSubtypeLabel || null,
    typeCandidates: x.typeCandidates || [],
    classification: x.classification || null,
    title: x.title,
    language: x.language,
    summary: x.summary,
    ocrUsed: Boolean(x.ocrUsed),
    textLayer: x.textLayer,
    pageCount: x.pageCount,
    overallConfidence: x.overallConfidence ?? null,
    fields: (x.fields || []).map(withTransliteration),
    ...(x.ocr ? { ocr: x.ocr, needs_review: needsReview(x.fields || []) } : {}),
    entities: x.entities || [],
    tables: x.tables || [],
    issues: x.issues || [],
    issueCounts: issueCounts(x.issues),
    hasGraph: Boolean(doc.graph?.nodes?.length),
    hasFile: Boolean(doc.file?.path),
    review: reviewSummary(x),
    audit: (doc.audit || []).slice(-AUDIT_IN_RESPONSE),
    auditCount: (doc.audit || []).length,
    translations: doc.translations || {},
    ...extra,
  };
}

/** Short form for lists (no fields, entities or tables). */
export function toDocumentSummary(doc) {
  const x = applyFieldPolicy(doc.extraction || {});
  return {
    id: String(doc._id),
    filename: doc.filename,
    mimeType: doc.mimeType,
    createdAt: doc.createdAt,
    fallbackUsed: doc.source === 'fallback',
    docType: x.docType,
    docTypeLabel: x.docTypeLabel,
    docTypeConfidence: x.docTypeConfidence,
    docCategory: x.docCategory || null,
    docSubtypeLabel: x.docSubtypeLabel || null,
    title: x.title,
    summary: x.summary,
    ocrUsed: Boolean(x.ocrUsed),
    pageCount: x.pageCount,
    overallConfidence: x.overallConfidence ?? null,
    fieldCount: (x.fields || []).filter(f => f.value != null).length,
    issueCounts: issueCounts(x.issues),
    hasGraph: Boolean(doc.graph?.nodes?.length),
    reviewStatus: reviewSummary(x).status,
  };
}

const csvCell = v => {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formulas (=, +, -, @ at the start).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * CSV export: one row per field, entity, issue and table row.
 * Starts with a UTF-8 BOM so Excel shows Hindi text correctly.
 */
export function toCsv(doc, { redact = false } = {}) {
  const d = redact ? redactDocument(toDocumentResponse(doc)) : toDocumentResponse(doc);
  const header = ['section', 'key', 'label', 'value', 'normalized_value', 'confidence', 'confidence_band', 'page', 'source_quote', 'review', 'ocr_status', 'agreement', 'ocr_confidence', 'ocr_candidates', 'validation', 'steps_applied'];
  const rows = [
    ['document', 'filename', 'File', d.filename],
    ['document', 'doc_type', 'Document type', d.docTypeLabel, d.docType, d.docTypeConfidence],
    ['document', 'summary', 'Summary', d.summary],
    ['document', 'ocr_used', 'OCR used', d.ocrUsed ? 'yes' : 'no'],
    ['document', 'page_count', 'Pages', d.pageCount],
    ['document', 'overall_confidence', 'Overall confidence', d.overallConfidence],
    ['document', 'review_status', 'Review status', d.review.status, `${d.review.reviewed}/${d.review.total} fields reviewed`],
    ...(d.redacted ? [['document', 'redacted', 'Personal data masked', d.redaction.fields.map(f => f.label).join('; ') || 'none found']] : []),
    ...d.fields.map(f => ['field', f.key, f.label, f.value, f.normalizedValue, f.confidence, f.confidenceBand, f.page, f.sourceQuote,
      f.review ? `${f.review.status} by ${f.review.by} at ${f.review.at}` : '', f.status, f.agreement, f.ocr?.confidence, f.candidates?.length ? JSON.stringify(f.candidates) : '', f.validation, f.steps_applied]),
    ...d.entities.map(e => ['entity', e.type, e.type, e.value, '', e.confidence, e.confidenceBand, e.page, e.sourceQuote]),
    ...d.issues.map(i => ['issue', i.type, i.severity, i.message, (i.fieldKeys || []).join('; ')]),
    ...d.tables.flatMap((t, ti) => [
      ['table', `table_${ti + 1}_columns`, t.title, t.columns.join(' | '), '', '', '', t.page],
      ...t.rows.map((r, ri) => ['table', `table_${ti + 1}_row_${ri + 1}`, t.title, r.join(' | '), '', '', '', t.page]),
    ]),
  ];
  return '\uFEFF' + [header, ...rows].map(r => header.map((_, i) => csvCell(r[i])).join(',')).join('\r\n') + '\r\n';
}

/** JSON export: the full document without stored page text (redact: personal data masked). */
export function toJsonExport(doc, { redact = false } = {}) {
  const { success, ...d } = redact ? redactDocument(toDocumentResponse(doc)) : toDocumentResponse(doc);
  return { exportedAt: new Date().toISOString(), ...d };
}
