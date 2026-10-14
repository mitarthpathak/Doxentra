/**
 * Entity graph of one owner's documents: who and what the documents are
 * about, and where they disagree. Pure function over stored documents.
 *
 *   workspace ─ person / organisation ─ document ─ key field
 *
 * People are grouped exactly as the cross-document checks group them
 * (shared identifier or same name), organisations by GSTIN (else name).
 * Each document hangs under its person, else its seller, else the
 * workspace; a buyer is a dashed "billed to" link. Fields are the ones
 * that identify or describe the entity (name, date of birth, IDs, invoice
 * number, total …) plus every field named in a cross-document issue.
 * Every cross-document issue becomes a red "mismatch" edge between the
 * conflicting fields, carrying the issue's message and severity.
 *
 * Node types reuse the concept-map rings: major (workspace), header
 * (person / organisation), sub-topic (document), concept (field).
 */
import { compactId } from './normalize.js';
import { crossDocumentIssues, groupPeople, personRecords } from './crossdoc.js';
import { getDocType } from './schemas.js';
import { nameKey } from './validate.js';

// Fields worth a node, in this order, besides the person's name and IDs.
const KEY_FIELDS = [
  'date_of_birth', 'father_or_guardian_name', 'mother_name', 'gender',
  'invoice_number', 'invoice_date', 'total_amount', 'seller_gstin', 'buyer_gstin',
  'certificate_title', 'issue_date', 'percentage_or_cgpa', 'result',
];
const MAX_FIELDS_PER_DOC = 6;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

const fieldsOf = doc => doc.extraction?.fields || doc.fields || [];
const docId = doc => String(doc._id ?? doc.id);
const titleOf = doc => doc.extraction?.title || doc.title || doc.filename;
const typeOf = doc => doc.extraction?.docType || doc.docType || 'other';
const shown = f => (Array.isArray(f.normalizedValue) ? f.normalizedValue.join('; ') : f.value);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const worse = (a, b) => (!a ? b : !b ? a : SEVERITY_ORDER[b] < SEVERITY_ORDER[a] ? b : a);

/** The seller and buyer of an invoice as { key, name, gstin }. */
function parties(doc) {
  if (typeOf(doc) !== 'invoice') return {};
  const get = key => fieldsOf(doc).find(f => f.key === key && f.value != null);
  const party = side => {
    const name = get(`${side}_name`);
    const gstin = get(`${side}_gstin`);
    if (!name && !gstin) return null;
    const key = gstin ? `gstin:${compactId(gstin.normalizedValue ?? gstin.value)}` : `name:${nameKey(name.value)}`;
    return { key, name: name?.value || gstin.value, gstin: gstin?.value || null };
  };
  return { seller: party('seller'), buyer: party('buyer') };
}

export function buildEntityGraph(docs) {
  const ordered = [...docs].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const issues = crossDocumentIssues(ordered);
  const nodes = [];
  const edges = [];
  const byId = new Map();
  const addNode = node => {
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
      nodes.push(node);
    }
    return byId.get(node.id);
  };
  const tree = (parent, child) => edges.push({ source: parent, target: child, label: 'contains', importance: 5 });

  addNode({ id: 'workspace', type: 'major', label: 'Your documents', caption: 'Workspace', parentId: null,
    desc: `${plural(docs.length, 'document')} in this workspace.` });

  // People, grouped like the cross-document checks group them.
  const parentOf = new Map(); // doc id → entity node id
  const shownFields = new Map(); // doc id → Set of field keys
  const want = (doc, key) => {
    if (!shownFields.has(docId(doc))) shownFields.set(docId(doc), new Set());
    shownFields.get(docId(doc)).add(key);
  };
  groupPeople(personRecords(ordered)).forEach((group, i) => {
    const names = [...new Set(group.records.map(r => r.nameField.value))];
    const idLabels = [...new Set(group.records.flatMap(r => r.ids.map(id => `${id.label} ${id.field.value}`)))];
    const linkedBy = [...group.links.values()].includes('id') ? 'a shared identifier' : group.records.length > 1 ? 'the same name' : null;
    const id = `person:${i}`;
    addNode({ id, type: 'header', label: names[0], caption: 'Person', parentId: 'workspace',
      desc: [
        `Appears in ${plural(new Set(group.records.map(r => docId(r.doc))).size, 'document')}${linkedBy ? `, linked by ${linkedBy}` : ''}.`,
        names.length > 1 ? `Also written as ${names.slice(1).map(n => `"${n}"`).join(', ')}.` : '',
        idLabels.length ? `Identifiers: ${idLabels.slice(0, 4).join(' · ')}.` : '',
      ].filter(Boolean).join(' ') });
    tree('workspace', id);
    for (const r of group.records) {
      if (!parentOf.has(docId(r.doc))) parentOf.set(docId(r.doc), id);
      want(r.doc, r.nameField.key);
      for (const a of Object.values(r.attrs)) want(r.doc, a.key);
      for (const x of r.ids) want(r.doc, x.field.key);
    }
  });

  // Organisations: invoice sellers and buyers.
  const orgId = key => `org:${key}`;
  const billedTo = [];
  for (const doc of ordered) {
    const { seller, buyer } = parties(doc);
    for (const p of [seller, buyer].filter(Boolean)) {
      const node = addNode({ id: orgId(p.key), type: 'header', label: p.name, caption: 'Organisation', parentId: 'workspace',
        desc: p.gstin ? `GSTIN ${p.gstin}.` : '', documents: new Set() });
      node.documents.add(docId(doc));
      if (!edges.some(e => e.target === node.id)) tree('workspace', node.id);
    }
    if (seller && !parentOf.has(docId(doc))) parentOf.set(docId(doc), orgId(seller.key));
    if (buyer) billedTo.push({ doc: docId(doc), org: orgId(buyer.key) });
  }
  for (const n of nodes) {
    if (!n.documents) continue;
    n.desc = `${n.desc ? `${n.desc} ` : ''}In ${plural(n.documents.size, 'document')}.`;
    delete n.documents;
  }

  // Documents and their key fields.
  for (const r of issues.flatMap(i => i.refs)) if (r.fieldKey) want({ _id: r.documentId }, r.fieldKey);
  for (const doc of ordered) {
    const id = `doc:${docId(doc)}`;
    const parent = parentOf.get(docId(doc)) || 'workspace';
    addNode({ id, type: 'sub-topic', label: titleOf(doc), caption: getDocType(typeOf(doc)).label, parentId: parent,
      documentId: docId(doc), desc: `${getDocType(typeOf(doc)).label} · ${doc.filename}.${doc.extraction?.summary ? ` ${doc.extraction.summary}` : ''}` });
    tree(parent, id);
    const keys = shownFields.get(docId(doc)) || new Set();
    const fields = fieldsOf(doc).filter(f => f.value != null);
    const chosen = [
      ...fields.filter(f => keys.has(f.key)),
      ...KEY_FIELDS.map(k => fields.find(f => f.key === k && !keys.has(k))).filter(Boolean),
    ].slice(0, Math.max(MAX_FIELDS_PER_DOC, keys.size));
    for (const f of chosen) {
      const fid = `field:${docId(doc)}:${f.key}`;
      addNode({ id: fid, type: 'concept', label: `${f.label}: ${shown(f)}`, caption: 'Field', parentId: id,
        documentId: docId(doc), fieldKey: f.key, desc: `${f.label}: ${shown(f)} — in ${titleOf(doc)}${f.page ? `, page ${f.page}` : ''}.` });
      tree(id, fid);
    }
  }
  for (const b of billedTo) edges.push({ source: `doc:${b.doc}`, target: b.org, label: 'billed to', importance: 2 });

  // Cross-document issues: red edges between the conflicting fields.
  const nodeFor = r => byId.get(`field:${r.documentId}:${r.fieldKey}`) || byId.get(`doc:${r.documentId}`);
  for (const issue of issues) {
    const ends = issue.refs.map(nodeFor).filter(Boolean);
    for (let a = 0; a < ends.length; a++) {
      for (let b = a + 1; b < ends.length; b++) {
        edges.push({ source: ends[a].id, target: ends[b].id, label: 'conflicts with', kind: 'mismatch',
          severity: issue.severity, rule: issue.rule, message: issue.message, importance: 6 });
        ends[a].severity = worse(ends[a].severity, issue.severity);
        ends[b].severity = worse(ends[b].severity, issue.severity);
      }
    }
  }

  const count = type => nodes.filter(n => n.caption === type).length;
  return {
    kind: 'entities',
    nodes,
    edges,
    issues,
    metadata: {
      title: 'People & Documents',
      description: 'People and organisations across your documents, and the values that disagree.',
      category: 'Entities',
    },
    stats: { people: count('Person'), organisations: count('Organisation'), documents: ordered.length,
      fields: count('Field'), mismatches: edges.filter(e => e.kind === 'mismatch').length },
  };
}
