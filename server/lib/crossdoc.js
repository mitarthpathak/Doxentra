/**
 * Cross-document checks over one owner's documents: the same person or
 * organisation described differently in two documents. Pure functions.
 *
 * People: each document's main person (student / recipient / applicant /
 * card holder) with their date of birth, parents' names, gender and
 * identifiers (roll / enrollment / ID numbers, PAN, email, phone).
 *  - Two documents are about the same person when they share an identifier
 *    (strong link), or when the names are the same (weak link: two people
 *    can share a name, so conflicts found that way are only warnings).
 *  - Conflicts: date of birth, father's / mother's name, gender, the name
 *    itself spelt differently, and one identifier carrying two different names.
 * Organisations (invoices): one GSTIN under two different names, and the same
 * invoice number from the same seller in two documents (different totals:
 * error; same total: possible duplicate submission).
 *
 * Issues: { rule, severity, type: 'cross_document', message,
 *           refs: [{ documentId, title, docType, filename, fieldKey, value }] }.
 */
import { compactId, normalizePhone } from './normalize.js';
import { nameKey, similarity } from './validate.js';

const PERSON_NAME_KEYS = ['student_name', 'recipient_name', 'applicant_name', 'holder_name'];
const PERSON_ATTRS = [
  { attr: 'dob', key: 'date_of_birth', label: 'Date of birth', kind: 'date', strong: 'error', weak: 'warning' },
  { attr: 'father', key: 'father_or_guardian_name', label: "Father's / guardian's name", kind: 'name', strong: 'warning', weak: 'info' },
  { attr: 'mother', key: 'mother_name', label: "Mother's name", kind: 'name', strong: 'warning', weak: 'info' },
  { attr: 'gender', key: 'gender', label: 'Gender', kind: 'enum', strong: 'warning', weak: 'info' },
];
// Fields that identify a person across documents.
const PERSON_ID_KEYS = new Set(['roll_number', 'enrollment_number', 'id_number', 'email', 'phone']);
const ID_LABELS = { roll_number: 'Roll no.', enrollment_number: 'Enrollment no.', id_number: 'ID no.', email: 'Email', phone: 'Phone', pan: 'PAN' };

export const CROSS_RULES = [
  ['cross.dob_mismatch', 'The same person has different dates of birth in two documents.'],
  ['cross.father_mismatch', "The same person's father's / guardian's name differs between documents."],
  ['cross.mother_mismatch', "The same person's mother's name differs between documents."],
  ['cross.gender_mismatch', "The same person's gender differs between documents."],
  ['cross.name_variant', "The same person's name is spelt differently in two documents."],
  ['cross.id_conflict', 'One identifier (roll no., PAN, email …) belongs to different names in two documents.'],
  ['cross.gstin_name_conflict', 'One GSTIN appears under two different business names.'],
  ['cross.invoice_conflict', 'The same invoice number from the same seller appears twice with different totals.'],
  ['cross.invoice_duplicate', 'The same invoice appears in two documents (possible duplicate submission).'],
].map(([id, description]) => ({ id, description }));

const fieldsOf = doc => doc.extraction?.fields || doc.fields || [];
const docInfo = doc => ({
  documentId: String(doc._id ?? doc.id),
  title: doc.extraction?.title || doc.title || doc.filename,
  docType: doc.extraction?.docType || doc.docType,
  filename: doc.filename,
});
const ref = (doc, field) => ({ ...docInfo(doc), fieldKey: field?.key || null, value: field?.value ?? null });
const shown = v => `"${v}"`;

function idKey(field) {
  const v = field.normalizedValue ?? field.value;
  if (v == null) return null;
  if (field.type === 'email') return `email:${String(v).toLowerCase()}`;
  if (field.type === 'phone') return `phone:${normalizePhone(v) || v}`;
  const id = compactId(v);
  // Masked numbers (XXXX XXXX 4321) only show a few digits and do not identify anyone.
  if (id.length < 4 || /[X*•]{3}/.test(id)) return null;
  // PANs are recognised by format wherever they appear; other numbers by field.
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(id) ? `pan:${id}` : `id:${id}`;
}

/** The main person of each document, with comparable attributes. */
export function personRecords(docs) {
  const out = [];
  for (const doc of docs) {
    const fields = fieldsOf(doc);
    const nameField = PERSON_NAME_KEYS.map(k => fields.find(f => f.key === k && f.value != null)).find(Boolean);
    if (!nameField) continue;
    const attrs = {};
    for (const a of PERSON_ATTRS) {
      const f = fields.find(x => x.key === a.key && x.value != null);
      if (f) attrs[a.attr] = f;
    }
    const ids = fields
      .filter(f => f.value != null && (PERSON_ID_KEYS.has(f.key) || f.format === 'pan' || /(^|_)pan$/.test(f.key)))
      .map(f => ({ field: f, key: idKey(f), label: ID_LABELS[f.key] || (f.format === 'pan' ? 'PAN' : f.label) }))
      .filter(i => i.key);
    out.push({ doc, nameField, nameKey: nameKey(nameField.value), attrs, ids });
  }
  return out;
}

/**
 * Group person records into people (union-find). Returns
 * [{ records, links: Map<"i|j", 'id'|'name'> }].
 */
export function groupPeople(records) {
  const parent = records.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const links = new Map();
  const link = (i, j, how) => {
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (!links.has(key) || how === 'id') links.set(key, how);
    parent[find(i)] = find(j);
  };
  const byId = new Map();
  records.forEach((r, i) => {
    for (const id of r.ids) {
      if (byId.has(id.key)) link(byId.get(id.key), i, 'id');
      else byId.set(id.key, i);
    }
  });
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (records[i].doc === records[j].doc) continue;
      if (records[i].nameKey && records[i].nameKey === records[j].nameKey) link(i, j, 'name');
    }
  }
  const groups = new Map();
  records.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()].map(idx => ({
    records: idx.map(i => records[i]),
    links: new Map([...links].filter(([k]) => idx.includes(Number(k.split('|')[0])))),
    indexes: idx,
  }));
}

function sameValue(kind, a, b) {
  if (kind === 'date') return (a.normalizedValue || a.value) === (b.normalizedValue || b.value);
  if (kind === 'name') return nameKey(a.value) === nameKey(b.value);
  return String(a.normalizedValue ?? a.value).toLowerCase() === String(b.normalizedValue ?? b.value).toLowerCase();
}

function personIssues(records) {
  const out = [];
  for (const group of groupPeople(records)) {
    if (group.records.length < 2) continue;
    const rs = group.records;
    for (let a = 0; a < rs.length; a++) {
      for (let b = a + 1; b < rs.length; b++) {
        const A = rs[a];
        const B = rs[b];
        if (A.doc === B.doc) continue;
        // Shared identifiers, labelled by the more specific side ("Roll no." over "ID no.").
        const sharedIds = A.ids
          .map(x => [x, B.ids.find(y => y.key === x.key)])
          .filter(([, y]) => y)
          .map(([x, y]) => ({ ...x, label: [x, y].find(k => k.field.key !== 'id_number')?.label || x.label }));
        const strong = sharedIds.length > 0;
        // Names: a variant spelling, or (with a shared id) a different person altogether.
        if (A.nameKey !== B.nameKey) {
          const close = A.nameKey.split(' ').length === B.nameKey.split(' ').length && similarity(A.nameKey, B.nameKey) >= 0.8;
          if (close) {
            out.push({ rule: 'cross.name_variant', severity: 'warning', message:
              `The same person's name is spelt ${shown(A.nameField.value)} in ${docInfo(A.doc).title} but ${shown(B.nameField.value)} in ${docInfo(B.doc).title}.`,
              refs: [ref(A.doc, A.nameField), ref(B.doc, B.nameField)] });
          } else if (strong) {
            const id = sharedIds[0];
            out.push({ rule: 'cross.id_conflict', severity: 'error', message:
              `${id.label} ${id.field.value} belongs to ${shown(A.nameField.value)} in ${docInfo(A.doc).title} but to ${shown(B.nameField.value)} in ${docInfo(B.doc).title}.`,
              refs: [ref(A.doc, id.field), ref(B.doc, B.ids.find(y => y.key === id.key).field)] });
            continue; // different people: their attributes are not comparable
          }
        }
        for (const spec of PERSON_ATTRS) {
          const fa = A.attrs[spec.attr];
          const fb = B.attrs[spec.attr];
          if (!fa || !fb || sameValue(spec.kind, fa, fb)) continue;
          const how = strong ? `(both documents have ${sharedIds[0].label} ${sharedIds[0].field.value})` : '(matched by name only; they may be two different people)';
          out.push({ rule: `cross.${spec.attr}_mismatch`, severity: strong ? spec.strong : spec.weak, message:
            `${spec.label} of ${A.nameField.value} differs: ${shown(fa.value)} in ${docInfo(A.doc).title} but ${shown(fb.value)} in ${docInfo(B.doc).title} ${how}.`,
            refs: [ref(A.doc, fa), ref(B.doc, fb)] });
        }
      }
    }
  }
  return out;
}

const field = (doc, key) => fieldsOf(doc).find(f => f.key === key && f.value != null) || null;
const amountOf = f => (f ? (typeof f.normalizedValue === 'number' ? f.normalizedValue : null) : null);
const rupees = n => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function organisationIssues(docs) {
  const out = [];
  const invoices = docs.filter(d => (d.extraction?.docType || d.docType) === 'invoice');

  // One GSTIN, two different business names.
  const byGstin = new Map();
  for (const doc of invoices) {
    for (const [g, n] of [['seller_gstin', 'seller_name'], ['buyer_gstin', 'buyer_name']]) {
      const gf = field(doc, g);
      const nf = field(doc, n);
      if (!gf || !nf) continue;
      const key = compactId(gf.normalizedValue ?? gf.value);
      if (!byGstin.has(key)) byGstin.set(key, []);
      byGstin.get(key).push({ doc, gf, nf });
    }
  }
  for (const [gstin, list] of byGstin) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        if (A.doc === B.doc || similarity(nameKey(A.nf.value), nameKey(B.nf.value)) >= 0.8) continue;
        out.push({ rule: 'cross.gstin_name_conflict', severity: 'warning', message:
          `GSTIN ${gstin} is ${shown(A.nf.value)} in ${docInfo(A.doc).title} but ${shown(B.nf.value)} in ${docInfo(B.doc).title}.`,
          refs: [ref(A.doc, A.nf), ref(B.doc, B.nf)] });
      }
    }
  }

  // The same invoice number from the same seller in two documents.
  const byInvoice = new Map();
  for (const doc of invoices) {
    const num = field(doc, 'invoice_number');
    if (!num) continue;
    const seller = field(doc, 'seller_gstin');
    const sellerKey = seller ? compactId(seller.normalizedValue ?? seller.value) : nameKey(field(doc, 'seller_name')?.value || '');
    const key = `${sellerKey}|${compactId(num.value)}`;
    if (!byInvoice.has(key)) byInvoice.set(key, []);
    byInvoice.get(key).push({ doc, num });
  }
  for (const list of byInvoice.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        if (A.doc === B.doc || (A.doc.fileHash && A.doc.fileHash === B.doc.fileHash)) continue;
        const seller = field(A.doc, 'seller_name')?.value || 'the same seller';
        const ta = field(A.doc, 'total_amount');
        const tb = field(B.doc, 'total_amount');
        const [va, vb] = [amountOf(ta), amountOf(tb)];
        if (va != null && vb != null && Math.abs(va - vb) > 0.5) {
          out.push({ rule: 'cross.invoice_conflict', severity: 'error', message:
            `Invoice ${A.num.value} from ${seller} appears in two documents with different totals: ${rupees(va)} in ${docInfo(A.doc).filename} but ${rupees(vb)} in ${docInfo(B.doc).filename}.`,
            refs: [ref(A.doc, ta), ref(B.doc, tb)] });
        } else {
          out.push({ rule: 'cross.invoice_duplicate', severity: 'warning', message:
            `Invoice ${A.num.value} from ${seller} appears in two documents (${docInfo(A.doc).filename} and ${docInfo(B.doc).filename}); it may have been submitted twice.`,
            refs: [ref(A.doc, A.num), ref(B.doc, B.num)] });
        }
      }
    }
  }
  return out;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * All cross-document issues of an owner's documents; with `documentId`, only
 * those that involve that document.
 */
export function crossDocumentIssues(docs, { documentId = null } = {}) {
  // Oldest first, so messages name the earlier document first.
  const ordered = [...docs].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const issues = [...personIssues(personRecords(ordered)), ...organisationIssues(ordered)]
    .map(i => ({ ...i, type: 'cross_document', fieldKeys: [] }))
    .filter(i => !documentId || i.refs.some(r => r.documentId === String(documentId)));
  const seen = new Set();
  return issues
    .filter(i => (seen.has(i.message) ? false : seen.add(i.message)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
