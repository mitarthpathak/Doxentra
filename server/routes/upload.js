import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { createRequire } from 'module';
import { analyzeDocument, buildFallbackGraph } from '../lib/ai.js';
import { findAiGraphByHash, findUserGraphByHash, saveGraph } from '../lib/db.js';
import { rateLimit } from '../lib/rateLimit.js';
import { MAX_UPLOAD_BYTES, detectFileType, precheckUpload } from '../lib/files.js';
import { isPrivacyMode } from '../lib/privacy.js';
import { processDocument } from '../lib/processDocument.js';
import { updateDocument, getDocument } from '../lib/db.js';
import { ocrConfig } from '../lib/ocr/config.js';

export { MAX_UPLOAD_BYTES };

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// The whole request must finish inside Vercel's 60s function limit.
const AI_BUDGET_MS = 50_000;
// Below this many characters we assume a scanned PDF and let Gemini read the file itself.
const MIN_TEXT_CHARS = 200;

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    try {
      precheckUpload(file);
      cb(null, true);
    } catch (err) {
      cb(err, false);
    }
  },
});
const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: 'Upload limit reached. Please try again in a few minutes.' });

function toResponse(doc, extra = {}) {
  return {
    success: true,
    id: String(doc._id),
    filename: doc.filename,
    graph: doc.graph,
    metadata: doc.metadata,
    createdAt: doc.createdAt,
    fallbackUsed: doc.source === 'fallback',
    ...extra,
  };
}

router.post('/upload', uploadLimiter, upload.single('pdf'), async (req, res) => {
  const startedAt = Date.now();
  if (!req.file) return res.status(400).json({ success: false, error: 'Please choose a PDF or image file to upload.' });
  if (isPrivacyMode() || ocrConfig().enabled) {
    const local = await processDocument(req.file, { owner: req.owner, deadline: startedAt + AI_BUDGET_MS });
    if (!local.success) return res.status(local.status || 422).json(local);
    const stored = req.owner ? await getDocument(local.id, req.owner) : null;
    const map = stored?.graph?.nodes?.length ? { graph: stored.graph, metadata: stored.metadata }
      : buildFallbackGraph([local.title, local.summary, ...local.fields.map(f => `${f.label}: ${f.value || ''}`)].join('\n'));
    if (req.owner) await updateDocument(local.id, req.owner, { graph: map.graph, metadata: map.metadata });
    return res.json({ success: true, id: local.id, filename: local.filename, graph: map.graph, metadata: map.metadata, createdAt: local.createdAt,
      fallbackUsed: !stored?.graph?.nodes?.length || local.fallbackUsed, warning: local.warning,
      ...(local.ocr ? { ocr: local.ocr, needs_review: local.needs_review } : {}) });
  }
  const fileType = detectFileType(req.file.buffer, req.file);
  const isImage = fileType.kind === 'image';

  let text = '';
  if (!isImage) {
    try {
      // Copy: small Buffers share Node's pool and pdf.js would read all of it.
      const parsed = await pdfParse(new Uint8Array(req.file.buffer));
      text = (parsed.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } catch (err) {
      console.error('[Upload] PDF text extraction failed:', err.message);
    }
  }
  // Images and PDFs without a text layer are read by Gemini directly.
  const scanned = text.length < MIN_TEXT_CHARS;

  const filename = req.file.originalname || (isImage ? 'image' : 'document.pdf');
  const userId = req.user?._id ?? null;
  const contentHash = crypto.createHash('sha256').update(scanned ? req.file.buffer : text).digest('hex');

  // Cache: identical documents are only analysed once.
  const cached = await findAiGraphByHash(contentHash).catch(() => null);
  if (cached) {
    console.log('[Upload] cache hit', contentHash.slice(0, 12));
    let doc = cached;
    if (userId && String(cached.userId) !== String(userId)) {
      // Give this user their own copy so it shows up in their history.
      doc = (await findUserGraphByHash(contentHash, userId).catch(() => null)) ||
        (await saveGraph({ filename, contentHash, graph: cached.graph, metadata: cached.metadata,
          source: 'ai', model: cached.model, userId }).catch(() => cached));
    }
    return res.json(toResponse(doc, { cached: true, filename }));
  }

  let result;
  let source = 'ai';
  let warning;
  try {
    const input = scanned ? { file: { data: req.file.buffer, mimeType: fileType.mimeType } } : { text };
    result = await analyzeDocument(input, { deadline: startedAt + AI_BUDGET_MS });
  } catch (err) {
    console.error('[Upload] AI analysis failed:', err.code || err.status || '', err.message);
    if (scanned) {
      return res.status(422).json({
        success: false,
        error: err.code === 'NO_API_KEY'
          ? `This ${isImage ? 'image needs OCR' : 'PDF has no selectable text'} and the AI service is not configured.`
          : `This ${isImage ? 'image needs OCR' : 'PDF has no selectable text'} and the AI service is busy right now. Please try again in a minute.`,
      });
    }
    result = buildFallbackGraph(text);
    source = 'fallback';
    warning = err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic keyword map was generated.'
      : 'The AI service is busy right now, so a basic keyword map was generated. Upload again later for a full AI map.';
  }

  const doc = {
    filename,
    contentHash,
    graph: result.graph,
    metadata: result.metadata,
    source,
    model: result.model,
    userId,
  };
  let saved;
  try {
    saved = await saveGraph(doc);
  } catch (err) {
    // Still return the result even if persistence fails.
    console.error('[Upload] could not save graph:', err.message);
    saved = { ...doc, _id: crypto.randomUUID(), createdAt: new Date() };
  }
  console.log(`[Upload] ${filename}: ${source}, ${result.graph.nodes.length} nodes in ${Date.now() - startedAt}ms`);
  res.json(toResponse(saved, warning ? { warning } : {}));
});

export default router;
