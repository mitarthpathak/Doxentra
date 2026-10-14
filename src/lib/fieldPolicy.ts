import type { DocumentResult } from '../types';

/** Bring an old browser session result in line with the current optional date policy. */
export function applyDocumentFieldPolicy(doc: DocumentResult): DocumentResult {
  if (doc.docType !== 'institutional_record') return doc;
  const fields = doc.fields.map(f => f.key === 'date' ? { ...f, required: false } : f);
  const issues = doc.issues.filter(i => !(i.rule === 'type.required_mostly_missing' ||
    (['required.missing', 'confidence.low'].includes(i.rule) && i.fieldKeys.length === 1 && i.fieldKeys[0] === 'date')));
  const basis = fields.filter(f => f.required);
  const penalties = { error: 0.05, warning: 0.02, info: 0 };
  const overallConfidence = Math.round(Math.max(0, Math.min(1, (basis.length ? basis.reduce((sum, f) => sum + f.confidence, 0) / basis.length : 0) - issues.reduce((sum, issue) => sum + penalties[issue.severity], 0))) * 100) / 100;
  return { ...doc, fields, issues, overallConfidence, issueCounts: { error: issues.filter(i => i.severity === 'error').length,
    warning: issues.filter(i => i.severity === 'warning').length, info: issues.filter(i => i.severity === 'info').length, total: issues.length } };
}
