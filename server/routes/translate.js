import express from 'express';
import { getDocument, updateDocument } from '../lib/db.js';
import { requireOwner } from '../lib/owner.js';
import { rateLimit } from '../lib/rateLimit.js';
import { translateDocument } from '../lib/translate.js';

const router = express.Router();
const translateLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Translation limit reached. Please try again in a few minutes.' });

/**
 * POST /api/documents/:id/translate  { to: 'en' | 'hi', refresh? }
 * Translation of the title, summary, text fields and page text. AI
 * translations are kept on the document until it is reviewed again.
 */
router.post('/documents/:id/translate', requireOwner, translateLimiter, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
  const to = String(req.body?.to || 'en');
  const cached = doc.translations?.[to];
  if (cached?.method === 'ai' && cached.basedOn === (doc.audit || []).length && !req.body?.refresh) {
    return res.json({ success: true, cached: true, translation: cached });
  }
  let translation;
  try {
    translation = await translateDocument(doc, { to });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    throw err;
  }
  await updateDocument(req.params.id, req.owner, { translations: { ...(doc.translations || {}), [to]: translation } });
  res.json({ success: true, cached: false, translation });
});

export default router;
