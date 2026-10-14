import { asciiDigits, normalizeValue } from '../normalize.js';
import { digitSensitive, fieldThreshold } from './config.js';

export const normalizedText = value => asciiDigits(String(value ?? '').normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim();
export function similarity(a, b) {
  a = normalizedText(a).replace(/\s/g, '').slice(0, 500); b = normalizedText(b).replace(/\s/g, '').slice(0, 500);
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** Fuzzy letters are allowed; a changed digit is never a trivial difference. */
export function valuesAgree(field, a, b, config) {
  if (a == null || b == null) return false;
  if (field.type === 'amount') {
    const currency = value => /(?:\bINR\b|\bRs\.?|₹)/i.test(value) ? 'INR' : /(?:\bUSD\b|\$)/i.test(value) ? 'USD'
      : /(?:\bEUR\b|€)/i.test(value) ? 'EUR' : /(?:\bGBP\b|£)/i.test(value) ? 'GBP' : null;
    const ca = currency(a); const cb = currency(b);
    if (ca && cb && ca !== cb) return false;
  }
  const na = normalizeValue(field, a, null); const nb = normalizeValue(field, b, null);
  if (['amount', 'number', 'date', 'id', 'phone'].includes(field.type) && na != null && nb != null) {
    return String(na).toLowerCase().replace(/\s/g, '') === String(nb).toLowerCase().replace(/\s/g, '');
  }
  const left = normalizedText(a); const right = normalizedText(b);
  if (left === right) return true;
  if ((digitSensitive(field) || /\d/.test(left + right)) && asciiDigits(left).replace(/\D/g, '') !== asciiDigits(right).replace(/\D/g, '')) return false;
  return similarity(left, right) >= config.fuzzyThreshold;
}

export function compareCandidates(field, candidates, config) {
  const threshold = fieldThreshold({ ...field, value: candidates.map(c => c.value || '').join(' ') }, config);
  const reads = [...new Map(candidates.filter(c => c.role !== 'extraction').map(c => [c.engine, c])).values()];
  const present = reads.filter(c => c.value != null);
  const independent = new Set(present.map(c => c.engine)).size >= 2;
  const agreement = independent && present.length === reads.length && present.every((a, i) => present.slice(i + 1).every(b => valuesAgree(field, a.value, b.value, config)));
  const confidence = present.length && present.every(c => c.confidence != null) ? Math.min(...present.map(c => c.confidence)) : 0;
  const reasons = [];
  if (!independent) reasons.push('insufficient_engines');
  if (reads.some(c => c.value == null)) reasons.push('missing_engine_value');
  if (present.some((a, i) => present.slice(i + 1).some(b => !valuesAgree(field, a.value, b.value, config)))) reasons.push('engine_disagreement');
  if (present.some(c => c.confidence == null)) reasons.push('confidence_unavailable');
  if (present.some(c => c.confidence != null && c.confidence < threshold)) reasons.push('low_ocr_confidence');
  // More than two engines may suggest a majority, but it never clears review.
  const groups = present.map(a => present.filter(b => valuesAgree(field, a.value, b.value, config)));
  const majority = groups.sort((a, b) => b.length - a.length)[0];
  const majorityHint = present.length >= 3 && majority?.length > present.length / 2 && !agreement
    ? { value: majority[0].value, engines: majority.map(c => c.engine), guaranteed: false } : null;
  return { agreement, agreementState: agreement ? 'agreed' : 'uncertain', confidence, threshold, reasons,
    ...(majorityHint ? { majorityHint } : {}), accepted: agreement && reasons.length === 0 };
}
