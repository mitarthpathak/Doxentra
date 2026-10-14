import { normalizeValue } from '../normalize.js';

/** Recheck withheld validation candidates against the current neighboring
 * fields, so their rules survive review/reset and can respond to corrections.
 */
export function ocrValidationInput(extraction) {
  return { ...extraction, fields: extraction.fields.map(field => {
    const candidate = field.status === 'needs_review' && field.ocr?.reasons.includes('validation_failed')
      ? field.candidates?.find(c => c.engine === 'validator' && c.role === 'extraction') : null;
    return candidate ? { ...field, value: candidate.value, normalizedValue: normalizeValue(field, candidate.value, null) } : field;
  }) };
}

export function validateOcrFields(extraction, issues, { enabled = extraction.ocr?.validationEnabled !== false } = {}) {
  if (!extraction.ocr) return extraction;
  const projected = ocrValidationInput(extraction);
  const fields = extraction.fields.map((field, i) => {
    if (!field.ocr) return field;
    const value = projected.fields[i].value;
    const rules = issues.filter(issue => issue.fieldKeys?.includes(field.key) && issue.severity !== 'info' &&
      ['format', 'inconsistent'].includes(issue.type)).map(issue => issue.rule);
    const validation = { passed: enabled && value != null ? rules.length === 0 : null,
      rule: !enabled ? 'disabled' : value == null ? 'not_evaluated' : rules[0] || 'format_and_consistency', rules };
    const next = { ...field, validation, steps_applied: [...new Set([...(field.steps_applied || []), ...(enabled ? ['validator'] : [])])] };
    const reviewed = field.review && field.review.status !== 'reset';
    if (enabled && rules.length && field.value != null && !reviewed) {
      const candidates = [...(field.candidates || []).filter(c => c.engine !== 'validator'),
        { engine: 'validator', role: 'extraction', value: field.value, confidence: field.ocr.confidence, page: field.page, box: field.box || null }];
      return { ...next, value: null, normalizedValue: null, status: 'needs_review', candidates,
        ocr: { ...field.ocr, reasons: [...new Set([...field.ocr.reasons, 'validation_failed'])] } };
    }
    return next;
  });
  return { ...extraction, fields };
}

export function ocrValidationIssues(fields, issues) {
  return fields.filter(f => f.status === 'needs_review' && !issues.some(i => i.rule === 'ocr.needs_review' && i.fieldKeys?.includes(f.key)))
    .map(f => ({ rule: 'ocr.needs_review', severity: 'warning', type: 'low_confidence', fieldKeys: [f.key],
      message: `${f.label} needs manual OCR review (${(f.ocr?.reasons || []).join(', ').replace(/_/g, ' ')}). Candidate values are retained; none was auto-accepted.` }));
}
