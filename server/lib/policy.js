import { generateStructured, parseJson } from './ai.js';
import { parseDate } from './normalize.js';

const TYPES = ['invoice', 'certificate', 'marksheet', 'application_form', 'report', 'identity_document', 'institutional_record', 'other'];
const KINDS = ['document_required', 'date_on_or_before', 'date_on_or_after', 'field_equals'];
const FIELD_KEYS = ['date_of_birth', 'invoice_date', 'due_date', 'issue_date', 'valid_until', 'expiry_date', 'date', 'effective_date', 'deadline_date', 'total_amount', 'percentage', 'roll_number', 'id_number'];
const DATE_KEYS = ['date_of_birth', 'invoice_date', 'due_date', 'issue_date', 'valid_until', 'expiry_date', 'date', 'effective_date', 'deadline_date'];
const TYPE_IN_QUOTE = {
  invoice: /invoice|bill|receipt|बीजक/i,
  certificate: /certificate|प्रमाणपत्र/i,
  marksheet: /mark\s*sheet|grade\s*sheet|transcript|अंकतालिका/i,
  application_form: /application form|आवेदन/i,
  report: /report|रिपोर्ट/i,
  identity_document: /identity|id card|aadhaar|passport|पहचान/i,
  institutional_record: /circular|notice|letter|परिपत्र|सूचना/i,
};
const words = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const containsWords = (text, phrase) => Boolean(words(phrase) && ` ${words(text)} `.includes(` ${words(phrase)} `));
export const policyLines = doc => (doc.extraction?.rawTextByPage || []).flatMap((page, p) =>
  String(page || '').split(/\r?\n/).map((line, i) => ({ id: `p${p + 1}l${i + 1}`, page: p + 1, line: i + 1, text: line.trim() })).filter(x => x.text.length >= 8));

const schema = { type: 'object', properties: { requirements: { type: 'array', items: { type: 'object', properties: {
  label: { type: 'string' }, kind: { type: 'string', enum: KINDS }, docType: { type: 'string', enum: TYPES },
  fieldKey: { type: 'string' }, expected: { type: 'string' }, sourceLineId: { type: 'string' }, quote: { type: 'string' },
}, required: ['label', 'kind', 'docType', 'sourceLineId', 'quote'] } } }, required: ['requirements'] };

function fallback(lines) {
  const patterns = [
    ['marksheet', /mark\s*sheet|grade\s*sheet|transcript/i],
    ['certificate', /certificate|प्रमाणपत्र/i],
    ['identity_document', /(?:identity|id) (?:card|proof)|aadhaar|passport/i],
    ['application_form', /application form/i],
    ['invoice', /invoice|fee receipt/i],
    ['report', /medical report|report card/i],
  ];
  return lines.flatMap(line => {
    const out = /required|submit|attach|enclose|provide|mandatory|must|आवश्यक|जमा|संलग्न/i.test(line.text)
      ? patterns.filter(([, re]) => re.test(line.text) && !/remain valid|valid through|valid until|expire/i.test(line.text))
        .map(([docType]) => ({ label: `Submit ${docType.replace(/_/g, ' ')}`, kind: 'document_required', docType, sourceLineId: line.id, quote: line.text })) : [];
    const date = line.text.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b|\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/);
    if (date && /certificate/i.test(line.text) && /valid (?:through|until|till)|expire(?:s|d)? (?:after|no earlier than)/i.test(line.text))
      out.push({ label: `Certificate valid through ${date[0]}`, kind: 'date_on_or_after', docType: 'certificate', fieldKey: 'valid_until', expected: date[0], sourceLineId: line.id, quote: line.text });
    return out;
  });
}

export function verifyRequirements(raw, lines) {
  const byId = new Map(lines.map(line => [line.id, line]));
  const seen = new Set();
  return (raw || []).slice(0, 40).flatMap((r, index) => {
    const line = byId.get(String(r.sourceLineId || ''));
    const quote = String(r.quote || '').trim();
    const kind = String(r.kind || '');
    const docType = String(r.docType || '');
    if (!line || quote.length < 5 || !containsWords(line.text, quote) || !KINDS.includes(kind) || !TYPES.includes(docType)) return [];
    if (kind === 'document_required' && !TYPE_IN_QUOTE[docType]?.test(quote)) return [];
    const fieldKey = String(r.fieldKey || '');
    const expected = String(r.expected || '').trim();
    if (kind.startsWith('date_')) {
      const dates = [...quote.matchAll(/\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b|\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/g)].map(m => parseDate(m[0]));
      if (!DATE_KEYS.includes(fieldKey) || !parseDate(expected) || !dates.includes(parseDate(expected))) return [];
    }
    if (kind === 'field_equals' && (!FIELD_KEYS.includes(fieldKey) || !expected || !containsWords(quote, expected))) return [];
    const key = `${kind}:${docType}:${fieldKey}:${expected}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: `r${index + 1}`, label: String(r.label || '').trim().slice(0, 140) || quote.slice(0, 140), kind, docType,
      ...(kind !== 'document_required' ? { fieldKey, expected } : {}), source: { page: line.page, line: line.line, quote } }];
  });
}

export async function buildPolicy(doc) {
  const lines = policyLines(doc).slice(0, 1000);
  if (!lines.length) throw Object.assign(new Error('This circular has no readable page text.'), { status: 422 });
  let proposed;
  let method = 'ai';
  try {
    const result = await generateStructured({ tag: 'Policy', schema, parts: [{ text:
      `Extract only explicit eligibility or submission requirements from this institution circular. Use exact source line ids and verbatim quotes. Never infer a rule. kind=document_required for a required proof. Use date_on_or_before or date_on_or_after only when the date constrains a field actually printed on that proof: an issue date before a cutoff, or an expiry date after a cutoff. Do not treat a submission deadline as a document field. Use field_equals only for an explicit value that appears in the quoted line. Allowed document types: ${TYPES.join(', ')}. Allowed field keys: ${FIELD_KEYS.join(', ')}. If no supported requirement exists return an empty array.\n\n${lines.map(l => `[${l.id}] ${l.text}`).join('\n').slice(0, 50000)}` }], parse: parseJson });
    proposed = result.requirements;
  } catch {
    proposed = fallback(lines);
    method = 'text_rules';
  }
  let requirements = verifyRequirements(proposed, lines);
  if (!requirements.length && method === 'ai') {
    requirements = verifyRequirements(fallback(lines), lines);
    if (requirements.length) method = 'text_rules';
  }
  return { requirements, method };
}

const docField = (doc, key) => doc.extraction?.fields?.find(f => f.key === key && f.value != null);
export function evaluatePolicy(requirements, packetDocs) {
  return requirements.map(rule => {
    const matching = packetDocs.filter(doc => doc.extraction?.docType === rule.docType);
    const base = { rule, status: 'missing', priority: 1, evidence: null, message: `Missing ${rule.docType.replace(/_/g, ' ')}.` };
    if (!matching.length) return base;
    if (rule.kind === 'document_required') {
      const doc = matching[0];
      return { ...base, status: 'met', priority: 4, message: `Found ${doc.filename}.`, evidence: { documentId: String(doc._id), filename: doc.filename, page: 1, quote: null, fieldKey: null } };
    }
    const candidates = matching.map(doc => ({ doc, field: docField(doc, rule.fieldKey) })).filter(x => x.field);
    if (!candidates.length) return { ...base, status: 'uncertain', priority: 2, message: `${rule.fieldKey} was not found in the submitted ${rule.docType.replace(/_/g, ' ')}.` };
    const { doc, field } = candidates[0];
    const actual = field.normalizedValue ?? field.value;
    const expected = rule.kind.startsWith('date_') ? parseDate(rule.expected) : rule.expected;
    const valid = rule.kind === 'date_on_or_before' ? Boolean(parseDate(actual) && parseDate(actual) <= expected)
      : rule.kind === 'date_on_or_after' ? Boolean(parseDate(actual) && parseDate(actual) >= expected) : words(actual) === words(expected);
    const status = !valid ? 'mismatch' : (field.confidence ?? 0) < 0.6 ? 'uncertain' : 'met';
    return { ...base, status, priority: { mismatch: 0, uncertain: 2, met: 4 }[status],
      message: `${field.label}: ${field.value}; required ${rule.kind === 'date_on_or_before' ? 'on or before' : rule.kind === 'date_on_or_after' ? 'on or after' : 'to equal'} ${rule.expected}.`,
      evidence: { documentId: String(doc._id), filename: doc.filename, page: field.page, quote: field.sourceQuote, fieldKey: field.key } };
  });
}
