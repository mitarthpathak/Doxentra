import express from 'express';
import { analyzeDocument, buildFallbackGraph } from '../lib/ai.js';
import { countFileReferences, deleteGraph, getDocument, listDocuments, updateDocument } from '../lib/db.js';
import { requireOwner } from '../lib/owner.js';
import { deleteObject, getObject, signedReadUrl } from '../lib/storage.js';
import { toCsv, toDocumentResponse, toDocumentSummary, toJsonExport } from '../lib/documentView.js';
import { rateLimit } from '../lib/rateLimit.js';
import { RULES } from '../lib/validate.js';
import { PII_KINDS, redactDocument, wantsRedaction as redactQuery } from '../lib/redact.js';
import { locateFieldBoxes } from '../lib/fieldLocations.js';
import { isPrivacyMode } from '../lib/privacy.js';

const router = express.Router();
const AI_BUDGET_MS = 50_000;
const mapLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: 'Upload limit reached. Please try again in a few minutes.' });
const locationLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, message: 'Please wait a moment before locating more text.' });

const notFound = res => res.status(404).json({ success: false, error: 'Document not found.' });
const safeName = s => String(s || 'document').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document';

// ?redact=1 (or true): personal data masked (server/lib/redact.js).
const wantsRedaction = req => redactQuery(req.query);

function sendExport(res, doc, format, { redact = false } = {}) {
  const name = safeName(redact ? redactDocument(toDocumentResponse(doc)).filename : doc.filename);
  const suffix = redact ? 'redacted' : 'extraction';
  if (format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}-${suffix}.csv"`);
    return res.send(toCsv(doc, { redact }));
  }
  if (format !== 'json') return res.status(400).json({ success: false, error: 'Format must be json or csv.' });
  res.set('Content-Disposition', `attachment; filename="${name}-${suffix}.json"`);
  res.json(toJsonExport(doc, { redact }));
}

/**
 * POST /api/documents/export?format=json|csv with a document result as the
 * body: formats a result the client already has (used when not signed in,
 * since anonymous results cannot be fetched back by id). Stores nothing.
 */
router.post('/documents/export', (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.fields)) return res.status(400).json({ success: false, error: 'Send a document result to export.' });
  const pick = ['docType', 'docTypeLabel', 'docTypeConfidence', 'title', 'language', 'summary', 'ocrUsed', 'textLayer', 'pageCount',
    'overallConfidence', 'fields', 'entities', 'tables', 'issues'];
  const extraction = Object.fromEntries(pick.filter(k => b[k] !== undefined).map(k => [k, b[k]]));
  const doc = { _id: String(b.id || ''), filename: String(b.filename || 'document'), mimeType: b.mimeType, createdAt: b.createdAt,
    source: b.fallbackUsed ? 'fallback' : 'ai', model: b.model, extraction };
  sendExport(res, doc, String(req.query.format || 'json').toLowerCase(), { redact: wantsRedaction(req) });
});

/** GET /api/privacy/pii-kinds: what a redacted view or export masks. */
router.get('/privacy/pii-kinds', (_req, res) => res.json({ success: true, kinds: PII_KINDS }));

/** GET /api/validation/rules: every validation rule (id, severity, type, description). */
router.get('/validation/rules', (_req, res) => res.json({ success: true, rules: RULES }));

// Saved document extractions of the signed-in user.
router.get('/documents', requireOwner, async (req, res) => {
  const docs = await listDocuments(req.owner);
  res.json({ success: true, documents: docs.map(toDocumentSummary) });
});

router.get('/documents/:id', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  res.json(wantsRedaction(req) ? redactDocument(toDocumentResponse(doc)) : toDocumentResponse(doc));
});

router.post('/documents/:id/field-locations', requireOwner, locationLimiter, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  const page = Number(req.body?.page ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > (doc.extraction?.pageCount || 1)) {
    return res.status(400).json({ success: false, error: 'Invalid document page.' });
  }
  try {
    const locations = await locateFieldBoxes(doc, req.owner, page);
    res.json({ success: true, page, locations });
  } catch (err) {
    console.error('[Locations] failed:', err.status || err.code || err.name);
    res.status(err.status === 404 ? 404 : err.status === 429 ? 429 : 503)
      .json({ success: false, error: 'Text could not be located on this page right now. Please try again.' });
  }
});

router.delete('/documents/:id', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc || !(await deleteGraph(req.params.id, req.owner))) return notFound(res);
  // The original file goes too, unless another document (a cached copy) uses it.
  if (doc.file?.path && !(await countFileReferences(doc.file.path).catch(() => 1))) await deleteObject(doc.file);
  res.json({ success: true });
});

/**
 * GET /api/documents/:id/file-url: where the browser can load the original
 * (for the page preview): a short-lived Supabase signed URL, or this API.
 */
router.get('/documents/:id/file-url', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  if (!doc.file?.path) return res.status(404).json({ success: false, error: 'The original file of this document is not stored.' });
  const external = await signedReadUrl(doc.file).catch(err => {
    console.error('[Storage] signing failed:', err.message);
    return null;
  });
  res.json({ success: true, url: external || `/api/documents/${encodeURIComponent(req.params.id)}/file`, external: Boolean(external), mimeType: doc.file.mimeType || doc.mimeType });
});

/** GET /api/documents/:id/file: the original file's bytes. */
router.get('/documents/:id/file', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  const data = doc.file ? await getObject(doc.file) : null;
  if (!data) return res.status(404).json({ success: false, error: 'The original file of this document is not stored.' });
  res.set('Content-Type', doc.file.mimeType || doc.mimeType || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=600');
  res.send(data);
});

router.get('/documents/:id/export', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  sendExport(res, doc, String(req.query.format || 'json').toLowerCase(), { redact: wantsRedaction(req) });
});

/**
 * Build the concept map / roadmap / quiz from an extracted document, so one
 * upload serves both features. The map is stored on the same record (and
 * then appears in History); a second call returns the stored map.
 */
router.post('/documents/:id/concept-map', requireOwner, mapLimiter, async (req, res) => {
  const startedAt = Date.now();
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  const respond = (d, extra = {}) => res.json({
    success: true, id: String(d._id), filename: d.filename, graph: d.graph, metadata: d.metadata,
    createdAt: d.createdAt, fallbackUsed: Boolean(d.graphFallback), ...extra,
  });
  if (doc.graph?.nodes?.length) return respond(doc, { cached: true });

  const text = (doc.extraction?.rawTextByPage || []).join('\n\n').trim();
  if (!text) {
    return res.status(422).json({ success: false, error: 'No readable text was found in this document, so a concept map cannot be built.' });
  }
  let result;
  let warning;
  let graphFallback = false;
  try {
    result = await analyzeDocument({ text }, { deadline: startedAt + AI_BUDGET_MS });
  } catch (err) {
    console.error('[ConceptMap] AI analysis failed:', err.code || err.status || '', err.message);
    result = buildFallbackGraph(text);
    graphFallback = true;
    warning = isPrivacyMode() ? 'High-Privacy Mode: a local keyword map was generated without cloud AI.' : err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic keyword map was generated.'
      : 'The AI service is busy right now, so a basic keyword map was generated.';
  }
  const updated = await updateDocument(doc._id, req.owner, { graph: result.graph, metadata: result.metadata, graphFallback });
  respond(updated || { ...doc, graph: result.graph, metadata: result.metadata, graphFallback }, warning ? { warning } : {});
});

export default router;
