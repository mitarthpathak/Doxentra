import express from 'express';
import { sanitizeQuality } from '../lib/quality.js';
import multer from 'multer';
import { detectFileType, precheckUpload } from '../lib/files.js';
import { createUploadTarget, maxDirectUploadBytes, maxUploadBytes, newObjectPath, putObject, storageDriver, supabaseConfigured } from '../lib/storage.js';
import { MAX_JOB_ITEMS, createExtractionJob, getJob, processJobItem, toJobResponse } from '../lib/jobs.js';
import { guestIdOf, ownerKey, requireOwner } from '../lib/owner.js';
import { requireAuth } from '../lib/auth.js';
import { claimGuestDocuments } from '../lib/db.js';
import { rateLimit } from '../lib/rateLimit.js';

const router = express.Router();
const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 80, message: 'Upload limit reached. Please try again in a few minutes.' });
const jobLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, message: 'Upload limit reached. Please try again in a few minutes.' });
function directUpload(req, res, next) {
  const maxBytes = maxDirectUploadBytes();
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      try {
        precheckUpload(file);
        cb(null, true);
      } catch (err) {
        cb(err, false);
      }
    },
  }).single('file')(req, res, err => {
    if (err?.code === 'LIMIT_FILE_SIZE') return bad(res, `File is too large. Maximum size is ${mb(maxBytes)}.`, 413);
    next(err);
  });
}

const bad = (res, error, status = 400) => res.status(status).json({ success: false, error });
const mb = n => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * POST /api/uploads/sign { filename, mimeType, size }
 * Where to upload a file: a signed Supabase Storage URL (the browser PUTs the
 * bytes there, so large files never pass through the API), or
 * { mode: 'direct' } to POST it to /api/uploads.
 */
router.post('/uploads/sign', requireOwner, uploadLimiter, async (req, res) => {
  const { filename = '', mimeType = '', size = 0 } = req.body || {};
  try {
    precheckUpload({ originalname: String(filename), mimetype: String(mimeType) });
  } catch (err) {
    return bad(res, err.message);
  }
  if (Number(size) > maxUploadBytes()) return bad(res, `"${filename}" is too large. Maximum size is ${mb(maxUploadBytes())}.`, 413);
  const target = await createUploadTarget({ ownerPrefix: ownerKey(req.owner), filename: String(filename), mimeType: String(mimeType) });
  res.json({ success: true, ...target });
});

/** POST /api/uploads: direct upload or a relay when the browser cannot reach Storage. */
router.post('/uploads', requireOwner, uploadLimiter, directUpload, async (req, res) => {
  if (!req.file) return bad(res, 'Please choose a PDF or image file to upload.');
  let type;
  try {
    type = detectFileType(req.file.buffer, req.file, { maxBytes: maxDirectUploadBytes() });
  } catch (err) {
    return bad(res, err.message, err.status || 400);
  }
  // Reuse the signed target on a network fallback. If Storage accepted the
  // browser's bytes but its response was lost, this overwrites the same object
  // rather than leaving a duplicate. Other owners' objects remain inaccessible.
  const prefix = `uploads/${ownerKey(req.owner)}/`;
  const existingPath = String(req.body?.path || '');
  if (existingPath && (!existingPath.startsWith(prefix) || existingPath.includes('..') || !/^[\w.-]+$/.test(existingPath.slice(prefix.length)))) {
    return bad(res, 'Unknown upload. Please upload the file again.', 403);
  }
  const ref = await putObject(existingPath || newObjectPath(ownerKey(req.owner), req.file.originalname), req.file.buffer, type.mimeType);
  res.json({ success: true, ...ref });
});

/**
 * POST /api/jobs { items: [{ path, filename, mimeType, size, quality? }] }
 * Queues uploaded files; the browser starts one processing request per item.
 */
router.post('/jobs', requireOwner, jobLimiter, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return bad(res, 'Please choose a PDF or image file to upload.');
  if (items.length > MAX_JOB_ITEMS) return bad(res, `Please upload at most ${MAX_JOB_ITEMS} files at a time.`);
  const prefix = `uploads/${ownerKey(req.owner)}/`;
  const driver = supabaseConfigured() ? 'supabase' : storageDriver();
  const clean = [];
  for (const i of items) {
    const path = String(i?.path || '');
    // Only files this owner uploaded can be processed.
    if (!path.startsWith(prefix) || path.includes('..')) return bad(res, 'Unknown upload. Please upload the file again.', 403);
    clean.push({
      path,
      driver,
      filename: String(i.filename || 'document').slice(0, 200),
      mimeType: String(i.mimeType || '').slice(0, 100),
      size: Number(i.size) || 0,
      quality: i.quality && typeof i.quality === 'object' ? sanitizeQuality(i.quality) : null,
    });
  }
  const job = await createExtractionJob(req.owner, clean);
  res.status(202).json({ success: true, job: toJobResponse((await getJob(job._id, req.owner)) || job) });
});

/** GET /api/jobs/:id: read-only progress of every item. */
router.get('/jobs/:id', requireOwner, async (req, res) => {
  const job = await getJob(req.params.id, req.owner);
  if (!job) return bad(res, 'Job not found.', 404);
  res.json({ success: true, job: toJobResponse((await getJob(job._id, req.owner)) || job) });
});

/** One file (or one page chunk) per request; never launch background batch work. */
router.post('/jobs/:id/items/:itemId/process', requireOwner, async (req, res) => {
  const job = await getJob(req.params.id, req.owner);
  if (!job || !job.items.some(i => i.id === req.params.itemId)) return bad(res, 'Job not found.', 404);
  await processJobItem(job, req.params.itemId);
  res.json({ success: true, job: toJobResponse(await getJob(job._id, req.owner)) });
});

/** POST /api/guest/claim: after signing in, move this browser's guest documents to the account. */
router.post('/guest/claim', requireAuth, async (req, res) => {
  const moved = await claimGuestDocuments(guestIdOf(req), req.user);
  res.json({ success: true, moved });
});

export default router;
