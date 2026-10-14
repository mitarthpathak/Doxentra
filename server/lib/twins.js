import crypto from 'crypto';
import { compactId } from './normalize.js';
import { nameKey } from './validate.js';
import { crossDocumentIssues } from './crossdoc.js';

const fields = doc => doc.extraction?.fields || [];
const field = (doc, key) => fields(doc).find(f => f.key === key && f.value != null);
const id = doc => String(doc._id);
const stamp = doc => new Date(doc.createdAt || 0).getTime();
const fileStem = doc => String(doc.filename || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/(?:[-_ ]?(?:v|version|rev)[-_ ]?\d+)$/, '').replace(/[^a-z0-9]/g, '');

function matchReason(a, b) {
  if (a.extraction?.docType !== b.extraction?.docType || a.fileHash && a.fileHash === b.fileHash) return null;
  if (a.extraction?.docType === 'invoice') {
    const number = [field(a, 'invoice_number'), field(b, 'invoice_number')];
    if (number.every(Boolean) && compactId(number[0].value) !== compactId(number[1].value)) return null;
    const seller = [field(a, 'seller_gstin'), field(b, 'seller_gstin')];
    const names = [field(a, 'seller_name'), field(b, 'seller_name')];
    if (number.every(Boolean) && compactId(number[0].value) === compactId(number[1].value) &&
      ((seller.every(Boolean) && compactId(seller[0].value) === compactId(seller[1].value)) ||
       (names.every(Boolean) && nameKey(names[0].value) === nameKey(names[1].value)))) return 'Same invoice number and seller';
  }
  for (const key of ['certificate_number', 'reference_number', 'application_number', 'report_number', 'id_number']) {
    const pair = [field(a, key), field(b, key)];
    if (pair.every(Boolean) && compactId(pair[0].value).length >= 5 && compactId(pair[0].value) === compactId(pair[1].value)) return `Same ${pair[0].label || key}`;
  }
  // Filename alone is weak. Require another stable extracted value as well.
  const stem = fileStem(a);
  if (stem.length >= 5 && stem === fileStem(b)) {
    for (const key of ['seller_gstin', 'seller_name', 'holder_name', 'student_name', 'recipient_name']) {
      const pair = [field(a, key), field(b, key)];
      if (pair.every(Boolean) && nameKey(pair[0].value) === nameKey(pair[1].value)) return 'Same filename and party';
    }
  }
  return null;
}

const comparable = f => f?.normalizedValue ?? f?.value ?? null;
function equal(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  return JSON.stringify(a).toLowerCase().replace(/\s+/g, ' ') === JSON.stringify(b).toLowerCase().replace(/\s+/g, ' ');
}
const source = (doc, f) => ({ documentId: id(doc), filename: doc.filename, value: f?.value ?? null,
  page: f?.page ?? null, sourceQuote: f?.sourceQuote ?? null, box: f?.box ?? null, hasFile: Boolean(doc.file?.path) });

export function documentTwin(doc, allDocs) {
  const previous = allDocs.filter(other => id(other) !== id(doc) &&
    (stamp(other) < stamp(doc) || stamp(other) === stamp(doc) && id(other) < id(doc)))
    .map(other => ({ other, reason: matchReason(doc, other) })).filter(x => x.reason)
    .sort((a, b) => stamp(b.other) - stamp(a.other))[0];
  if (!previous) return null;
  const old = previous.other;
  const oldFields = new Map(fields(old).map(f => [f.key, f]));
  const changes = fields(doc).flatMap(f => {
    const prior = oldFields.get(f.key);
    if (!prior || equal(comparable(prior), comparable(f))) return [];
    if (prior.value == null && f.value == null) return [];
    return [{ key: f.key, label: f.label || prior.label || f.key, before: source(old, prior), after: source(doc, f) }];
  });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ previousId: id(old), changes: changes.map(c => [c.key, c.before.value, c.after.value]) })).digest('hex');
  const earlier = allDocs.filter(d => id(d) === id(doc) || stamp(d) < stamp(doc) || stamp(d) === stamp(doc) && id(d) < id(doc));
  const conflicts = crossDocumentIssues(earlier, { documentId: id(doc) }).filter(issue =>
    issue.severity !== 'info' && issue.refs.some(r => r.documentId !== id(doc)));
  const saved = doc.twinReview;
  return { previousId: id(old), previousFilename: old.filename, matchReason: previous.reason, changes, conflicts,
    fingerprint, review: saved?.previousId === id(old) && saved.fingerprint === fingerprint ? saved : null };
}
