import { asciiDigits, compactId, parseAmount, parseDate, parseNumber } from '../../server/lib/normalize.js';

const text = value => asciiDigits(String(value ?? '').normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim();
const words = value => text(value).match(/[\p{L}\p{N}\p{M}]+/gu) || [];

export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
      previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

export function fieldMatches(expected, field) {
  if (field?.value == null) return false;
  const value = field.value;
  if (field.type === 'date') return parseDate(expected) != null && parseDate(expected) === parseDate(value);
  if (['amount', 'number'].includes(field.type)) {
    const parse = field.type === 'amount' ? parseAmount : parseNumber;
    return parse(expected) != null && parse(value) != null && Math.abs(parse(expected) - parse(value)) < 0.005;
  }
  if (field.type === 'id') return compactId(expected) === compactId(value);
  if (field.type === 'phone') return text(expected).replace(/\D/g, '') === text(value).replace(/\D/g, '');
  // Evaluation is stricter than the OCR agreement heuristic: similar spellings
  // are not ground-truth correctness, and a changed digit never earns credit.
  return words(expected).join(' ') === words(value).join(' ');
}

/** Micro-averaged errors over expected field values, not whole-page OCR text.
 * Missing/withheld values count as deletions; unexpected extra fields are
 * reported separately and are outside the annotated field denominator.
 */
export function measureFields(extraction, expected) {
  const fields = Object.entries(expected.fields).map(([key, truth]) => {
    const field = extraction?.fields?.find(f => f.key === key);
    const alternatives = Array.isArray(truth) ? truth : [truth];
    const actual = field?.value ?? '';
    const comparisons = alternatives.map(value => {
      const chars = [...text(value)], tokens = words(value);
      return { expected: value, characterEdits: editDistance(chars, [...text(actual)]), characterCount: chars.length,
        wordEdits: editDistance(tokens, words(actual)), wordCount: tokens.length };
    });
    const best = comparisons.sort((a, b) => a.characterEdits / Math.max(1, a.characterCount) - b.characterEdits / Math.max(1, b.characterCount))[0];
    return { key, actual: field?.value ?? null, ...best, correct: alternatives.some(value => fieldMatches(value, field)),
      emitted: field?.value != null, needsReview: field?.status === 'needs_review' };
  });
  const sum = key => fields.reduce((n, f) => n + Number(f[key]), 0);
  const correct = sum('correct'), emitted = sum('emitted');
  return { total: fields.length, correct, emitted, pending: sum('needsReview'), characterEdits: sum('characterEdits'),
    characterCount: sum('characterCount'), wordEdits: sum('wordEdits'), wordCount: sum('wordCount'),
    fieldAccuracy: fields.length ? correct / fields.length : null,
    emittedAccuracy: emitted ? correct / emitted : null, coverage: fields.length ? emitted / fields.length : null,
    cer: sum('characterCount') ? sum('characterEdits') / sum('characterCount') : null,
    wer: sum('wordCount') ? sum('wordEdits') / sum('wordCount') : null,
    extraFields: (extraction?.fields || []).filter(f => f.value != null && !(f.key in expected.fields)).length, fields };
}

export function summarizeStages(rows, stages) {
  return Object.fromEntries(stages.map(stage => {
    const runs = rows.filter(row => row.stage === stage);
    const sum = key => runs.reduce((n, row) => n + row[key], 0);
    const total = sum('total'), emitted = sum('emitted');
    return [stage, { runs: runs.length, failures: runs.filter(row => row.error).length, total, correct: sum('correct'), emitted,
      pending: sum('pending'), fieldAccuracy: total ? sum('correct') / total : null,
      emittedAccuracy: emitted ? sum('correct') / emitted : null, coverage: total ? emitted / total : null,
      cer: sum('characterCount') ? sum('characterEdits') / sum('characterCount') : null,
      wer: sum('wordCount') ? sum('wordEdits') / sum('wordCount') : null }];
  }));
}
