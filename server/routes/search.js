import express from 'express';
import { searchCandidates } from '../lib/db.js';
import { requireOwner } from '../lib/owner.js';
import { searchDocuments } from '../lib/search.js';
import { DOC_TYPE_IDS } from '../lib/schemas.js';

const router = express.Router();
const isDate = s => !s || !Number.isNaN(new Date(s).getTime());

/**
 * GET /api/search?q=&type=&minConfidence=&from=&to=
 * Searches the owner's documents (signed-in user or guest workspace) (fields, entities, summaries, page text).
 */
router.get('/search', requireOwner, async (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  const type = String(req.query.type || '');
  const minConfidence = req.query.minConfidence === undefined || req.query.minConfidence === '' ? null : Number(req.query.minConfidence);
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (type && !DOC_TYPE_IDS.includes(type)) return res.status(400).json({ success: false, error: 'Unknown document type.' });
  if (minConfidence != null && !(minConfidence >= 0 && minConfidence <= 1)) {
    return res.status(400).json({ success: false, error: 'minConfidence must be between 0 and 1.' });
  }
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ success: false, error: 'Dates must look like YYYY-MM-DD.' });

  const docs = await searchCandidates(req.owner, { q, type, from, to });
  const results = searchDocuments(docs, { q, type, minConfidence, from, to });
  res.json({ success: true, query: q, count: results.length, results });
});

export default router;
