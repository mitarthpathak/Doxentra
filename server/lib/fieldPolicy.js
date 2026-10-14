import { overallConfidence } from './confidence.js';

/** Broad institutional records do not establish that a date must be present. */
export function applyFieldPolicy(extraction) {
  if (extraction?.docType !== 'institutional_record') return extraction;
  const fields = (extraction.fields || []).map(f => f.key === 'date' ? { ...f, required: false } : f);
  const issues = (extraction.issues || []).filter(i => !(i.rule === 'type.required_mostly_missing' ||
    (['required.missing', 'confidence.low'].includes(i.rule) && i.fieldKeys?.length === 1 && i.fieldKeys[0] === 'date')));
  const changed = fields.some((f, i) => f.required !== extraction.fields[i].required) || issues.length !== (extraction.issues || []).length;
  return changed ? { ...extraction, fields, issues, overallConfidence: overallConfidence(fields, issues) } : extraction;
}
