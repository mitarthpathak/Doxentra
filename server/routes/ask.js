import express from 'express';
import { getDocument, searchCandidates } from '../lib/db.js';
import { requireOwner } from '../lib/owner.js';
import { askDocuments } from '../lib/ask.js';
import { rateLimit } from '../lib/rateLimit.js';

const router = express.Router();
const askLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, message: 'Too many questions. Please wait a few minutes.' });
// Answers must come back well inside the serverless limit.
const AI_BUDGET_MS = 40_000;
const MAX_DOCS = 60;

/**
 * POST /api/ask { question, documentId?, history? }
 * Answers from one document (documentId) or all of the owner's documents,
 * with citations: { answer, answerable, citations: [{ n, documentId, title,
 * page, fieldKey?, quote, verified }], followUps, mode: 'ai'|'extractive' }.
 */
router.post('/ask', requireOwner, askLimiter, async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question) return res.status(400).json({ success: false, error: 'Please type a question.' });
  if (question.length > 1000) return res.status(400).json({ success: false, error: 'Please keep the question under 1,000 characters.' });
  const documentId = req.body?.documentId ? String(req.body.documentId) : null;

  let docs;
  if (documentId) {
    const doc = await getDocument(documentId, req.owner);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
    docs = [doc];
  } else {
    docs = (await searchCandidates(req.owner, {})).slice(0, MAX_DOCS);
  }
  const startedAt = Date.now();
  const result = await askDocuments(question, docs, { history: req.body?.history, deadline: startedAt + AI_BUDGET_MS });
  res.json({ success: true, question, scope: documentId ? 'document' : 'all', documentCount: docs.length, elapsedMs: Date.now() - startedAt, ...result });
});

export default router;
