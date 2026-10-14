import { crossDocumentIssues } from './crossdoc.js';
import { documentTwin } from './twins.js';
import { evaluatePolicy } from './policy.js';
import { parseDate } from './normalize.js';

export function packetReview(packet, docs, policyDoc = null, now = new Date()) {
  const byId = new Map(docs.map(doc => [String(doc._id), doc]));
  const members = packet.documentIds.map(id => byId.get(String(id))).filter(Boolean);
  const requirements = policyDoc?.policy?.requirements || [];
  const checklist = evaluatePolicy(requirements, members);
  const tasks = [];
  for (const result of checklist) if (result.status !== 'met') tasks.push({ kind: 'policy', status: result.status, priority: result.priority,
    message: result.message, ruleSource: { documentId: String(policyDoc._id), ...result.rule.source }, evidence: result.evidence, ruleId: result.rule.id });
  for (const issue of crossDocumentIssues(members)) tasks.push({ kind: 'conflict', status: 'mismatch', priority: issue.severity === 'error' ? 0 : 1,
    message: issue.message, refs: issue.refs });
  for (const doc of members) {
    for (const field of doc.extraction?.fields || []) {
      if (field.value == null) continue;
      if (['valid_until', 'expiry_date'].includes(field.key)) {
        const date = parseDate(field.normalizedValue ?? field.value);
        if (date && date < now.toISOString().slice(0, 10)) tasks.push({ kind: 'expired', status: 'expired', priority: 0,
          message: `${doc.filename}: ${field.label} was ${field.value}.`, evidence: { documentId: String(doc._id), fieldKey: field.key, page: field.page, quote: field.sourceQuote } });
      }
      if (field.required && (field.confidence ?? 0) < 0.6) tasks.push({ kind: 'uncertain', status: 'uncertain', priority: 2,
        message: `${doc.filename}: ${field.label} needs verification (${Math.round((field.confidence ?? 0) * 100)}% confidence).`,
        evidence: { documentId: String(doc._id), fieldKey: field.key, page: field.page, quote: field.sourceQuote } });
    }
  }
  const changes = members.map(doc => ({ documentId: String(doc._id), twin: documentTwin(doc, docs) })).filter(x => x.twin && x.twin.changes.length);
  for (const { documentId, twin } of changes) if (twin.review?.status !== 'approve') tasks.push({ kind: 'change', status: twin.review?.status || 'unreviewed', priority: 1,
    message: `${twin.changes.length} change(s) in ${byId.get(documentId).filename} compared with ${twin.previousFilename}.`, evidence: { documentId, fieldKey: twin.changes[0]?.key } });
  tasks.sort((a, b) => a.priority - b.priority || a.message.localeCompare(b.message));
  return { id: String(packet._id), title: packet.title, documentIds: packet.documentIds, policyId: packet.policyId,
    documents: members.map(doc => ({ id: String(doc._id), filename: doc.filename, title: doc.extraction?.title, docType: doc.extraction?.docType })),
    policy: policyDoc ? { id: String(policyDoc._id), filename: policyDoc.filename, requirements } : null,
    checklist, changes, tasks, counts: { urgent: tasks.filter(t => t.priority === 0).length, attention: tasks.filter(t => t.priority === 1).length, verify: tasks.filter(t => t.priority === 2).length },
    updatedAt: packet.updatedAt };
}
