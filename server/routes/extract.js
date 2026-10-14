import express from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES, precheckUpload } from '../lib/files.js';
import { rateLimit } from '../lib/rateLimit.js';
import { failResult, processDocument } from '../lib/processDocument.js';
import { newObjectPath, putObject } from '../lib/storage.js';
import { ownerKey } from '../lib/owner.js';
import { sanitizeQuality } from '../lib/quality.js';

// The whole request must finish inside Vercel's 60 s function limit.
const AI_BUDGET_MS = 50_000;
// Files in one request are processed in parallel; the 4 MB body limit applies to all of them together.
export const MAX_FILES_PER_REQUEST = 5;

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    try {
      precheckUpload(file);
      cb(null, true);
    } catch (err) {
      cb(err, false);
    }
  },
});
const extractLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, message: 'Upload limit reached. Please try again in a few minutes.' });

/**
 * POST /api/extract  (multipart, field "files", up to 5 files; "file" also accepted)
 * Every file is processed independently and saved as its own document.
 * Optional field "quality": a JSON array of image-quality reports, one per
 * file in order (null for PDFs), as measured by the browser.
 * Responds { success, documents: [...] }; a file that fails has
 * { success: false, filename, error } in the list. When every file fails the
 * response status is that of the first failure.
 */
router.post('/extract', extractLimiter,
  upload.fields([{ name: 'files', maxCount: MAX_FILES_PER_REQUEST }, { name: 'file', maxCount: 1 }]),
  async (req, res) => {
    const startedAt = Date.now();
    const files = [...(req.files?.files || []), ...(req.files?.file || [])].slice(0, MAX_FILES_PER_REQUEST);
    if (!files.length) return res.status(400).json({ success: false, error: 'Please choose a PDF or image file to upload.' });

    const owner = req.owner || null;
    const deadline = startedAt + AI_BUDGET_MS;
    let reports = [];
    try {
      reports = req.body?.quality ? JSON.parse(String(req.body.quality)) : [];
    } catch {
      return res.status(400).json({ success: false, error: 'quality must be a JSON array.' });
    }
    const qualityOf = i => (Array.isArray(reports) && reports[i] && typeof reports[i] === 'object' ? sanitizeQuality(reports[i]) : null);
    const documents = await Promise.all(files.map((file, i) =>
      processDocument(file, {
        owner,
        deadline,
        quality: qualityOf(i),
        // The original is kept for the page preview (stored only when a document is saved).
        fileRef: type => putObject(newObjectPath(ownerKey(owner), file.originalname), file.buffer, type.mimeType),
      }).catch(err => {
        console.error('[Extract] unexpected error:', err);
        return failResult(file.originalname || 'document', 500, 'Something went wrong while reading this file. Please try again.');
      })));

    for (const d of documents) {
      console.log(`[Extract] ${d.filename}: ${d.success ? `${d.docType}${d.cached ? ' (cached)' : ''}${d.fallbackUsed ? ' (fallback)' : ''}` : `failed (${d.status})`}`);
    }
    const okCount = documents.filter(d => d.success).length;
    if (!okCount) {
      const first = documents[0];
      return res.status(first.status || 422).json({ success: false, error: first.error, documents });
    }
    res.json({ success: true, documents, elapsedMs: Date.now() - startedAt });
  });

export default router;
