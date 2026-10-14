import express from 'express';
import { getDocument, listDocuments, updateDocument } from '../lib/db.js';
import { ownerLabel, requireOwner } from '../lib/owner.js';
import { reviewDocument, reviewField } from '../lib/review.js';
import { issueCounts, toDocumentResponse } from '../lib/documentView.js';
import { documentTwin } from '../lib/twins.js';
import { isPrivacyMode } from '../lib/privacy.js';
import { maskPrivacyDocument } from '../lib/privacyDocument.js';

const router = express.Router();
const notFound = res => res.status(404).json({ success: false, error: 'Document not found.' });

/** Run a review action on a stored document and save it with its audit entry. */
async function apply(req, res, act) {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  let result;
  try {
    result = act(doc.extraction, { by: ownerLabel(req.owner), now: new Date() });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    throw err;
  }
  if (isPrivacyMode()) {
    const masked = maskPrivacyDocument({ ...doc, extraction: result.extraction, audit: [...(doc.audit || []), result.audit] });
    result.extraction = masked.extraction;
    result.audit = masked.audit.at(-1);
  }
  const saved = await updateDocument(req.params.id, req.owner, { extraction: result.extraction },
    { audit: result.audit, auditLength: (doc.audit || []).length });
  if (!saved) {
    return res.status(409).json({ success: false, error: 'The document was changed in the meantime. Reload it and try again.' });
  }
  res.json(toDocumentResponse(saved, { auditEntry: result.audit }));
}

/**
 * PATCH /api/documents/:id/fields/:key  { action: confirm | correct | reset, value?, note? }
 * Confirm, correct or reset one field; the document is validated again.
 */
router.patch('/documents/:id/fields/:key', requireOwner, (req, res) =>
  apply(req, res, (x, ctx) => reviewField(x, req.params.key, req.body || {}, ctx)));

/** POST /api/documents/:id/review  { action: approve | reopen, note? } */
router.post('/documents/:id/review', requireOwner, (req, res) =>
  apply(req, res, (x, ctx) => reviewDocument(x, req.body || {}, ctx)));

/** Compare a newly uploaded document to its most recent matching predecessor. */
router.get('/documents/:id/twin', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  const twin = documentTwin(doc, await listDocuments(req.owner, 300));
  res.json({ success: true, twin });
});

/** Record a human decision on exactly the comparison the reviewer saw. */
router.post('/documents/:id/twin/review', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  const twin = documentTwin(doc, await listDocuments(req.owner, 300));
  if (!twin || !twin.changes.length) return res.status(400).json({ success: false, error: 'There are no changes to review.' });
  if (req.body?.fingerprint !== twin.fingerprint) return res.status(409).json({ success: false, error: 'The comparison changed. Reload it and try again.' });
  const action = req.body?.action;
  if (!['approve', 'needs_review'].includes(action)) return res.status(400).json({ success: false, error: 'Action must be approve or needs_review.' });
  const note = req.body?.note == null ? '' : String(req.body.note).trim().slice(0, 300);
  const review = { previousId: twin.previousId, fingerprint: twin.fingerprint, status: action, by: ownerLabel(req.owner), at: new Date().toISOString(), ...(note ? { note } : {}) };
  const audit = { at: review.at, by: review.by, action: action === 'approve' ? 'twin_approve' : 'twin_needs_review',
    from: twin.previousFilename, to: doc.filename, previousId: twin.previousId, fingerprint: twin.fingerprint,
    changedFields: twin.changes.map(c => c.key), ...(note ? { note } : {}),
    issuesBefore: issueCounts(doc.extraction?.issues),
    issuesAfter: issueCounts(doc.extraction?.issues),
    overallBefore: doc.extraction?.overallConfidence ?? null, overallAfter: doc.extraction?.overallConfidence ?? null };
  const saved = await updateDocument(req.params.id, req.owner, { twinReview: review }, { audit, auditLength: (doc.audit || []).length });
  if (!saved) return res.status(409).json({ success: false, error: 'The document changed. Reload it and try again.' });
  res.json({ success: true, twin: documentTwin(saved, await listDocuments(req.owner, 300)), document: toDocumentResponse(saved) });
});

/** GET /api/documents/:id/audit: the full review trail, oldest first. */
router.get('/documents/:id/audit', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  res.json({ success: true, audit: doc.audit || [] });
});

export default router;
