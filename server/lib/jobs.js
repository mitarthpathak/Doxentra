/** Request-driven extraction: one file or PDF chunk per POST, with MongoDB checkpoints. */
import crypto from 'crypto';
import { createJob, getJob, leaseJobItem, updateJobItem } from './db.js';
import { getObject, maxUploadBytes, deleteObject } from './storage.js';
import { isPrivacyMode } from './privacy.js';
import { processDocument } from './processDocument.js';
import { processPdfChunk } from './pdfChunks.js';
import { detectFileType } from './files.js';
import { ownerFields } from './owner.js';
import { isTransientError } from './serviceErrors.js';
import { isGeminiRateLimit } from './geminiPool.js';

export const MAX_JOB_ITEMS = 10;
// Items of one job processed at the same time.
export const JOB_CONCURRENCY = 3;
// Longer than one item can take, including download, validation and save.
const LEASE_MS = 75_000;
// Page OCR + text reasoning + selective verification fit under Vercel's 60s request limit.
const AI_BUDGET_MS = 48_000;
const MAX_ATTEMPTS = 2;

/** Rough progress per stage, shown while an item is processed. */
export const STAGE_PROGRESS = { queued: 0, downloading: 8, reading: 18, local_ocr: 22, reading_groq: 22, reading_groq_quota: 22,
  extracting: 30, local_extract: 30, ocr_crosscheck: 70, ocr_reprocessing: 78, validating: 90, saving: 96, done: 100 };

export async function createExtractionJob(owner, items) {
  return createJob({
    ...ownerFields(owner),
    items: items.map(i => ({
      id: crypto.randomBytes(6).toString('hex'),
      filename: i.filename,
      mimeType: i.mimeType,
      size: i.size,
      storagePath: i.path,
      storageDriver: i.driver,
      quality: i.quality || null,
      status: 'queued',
      stage: 'queued',
      stageStartedAt: new Date(),
      progress: 0,
      attempts: 0,
    })),
  });
}

const leaseValid = item => item.leaseUntil && new Date(item.leaseUntil) > new Date();
const quotaReady = item => !item.nextAttemptAt || new Date(item.nextAttemptAt) <= new Date();

/** Lease and await exactly one item in this HTTP invocation. */
export async function processJobItem(job, itemId) {
  const item = job.items.find(i => i.id === itemId);
  if (!item) return;
  if (!quotaReady(item)) return;
  const stale = item.status === 'running' && !leaseValid(item);
  if (stale && (item.attempts || 0) >= MAX_ATTEMPTS) {
    await updateJobItem(job._id, item.id, { status: 'failed', stage: 'failed', errorStage: item.stage, stageStartedAt: new Date(), error: 'Processing took too long. Please try uploading this file again.', finishedAt: new Date() }, { leaseUntil: item.leaseUntil });
    return;
  }
  const leased = await leaseJobItem(job._id, item.id, LEASE_MS);
  if (leased) await runItem(leased, item.id);
}

/** Process one leased item. Never throws: failures are recorded on the item. */
export async function runItem(job, itemId) {
  const item = job.items.find(i => i.id === itemId);
  const startedAt = Date.now();
  let stage = item.stage;
  let pageProgress = item.pageProgress;
  let leaseUntil = item.leaseUntil;
  let updates = Promise.resolve();
  // Serialize progress and heartbeat writes so they use the current lease token.
  const set = patch => {
    const update = updates.then(async () => {
      if (patch.stage && patch.stage !== stage) patch.stageStartedAt = new Date();
      if (isPrivacyMode() && (!patch.status || patch.status === 'running')) patch.leaseUntil = new Date(Date.now() + LEASE_MS);
      const updated = await updateJobItem(job._id, itemId, patch, { leaseUntil });
      if (!updated) throw new Error('Processing lease is no longer owned by this request');
      if (patch.leaseUntil) leaseUntil = patch.leaseUntil;
      if (patch.stage) stage = patch.stage;
      if (patch.pageProgress) pageProgress = patch.pageProgress;
      return updated;
    });
    updates = update.catch(() => {});
    return update;
  };
  // Local OCR may process many pages or wait behind another upload.
  const heartbeat = isPrivacyMode() ? setInterval(() => {
    void set({}).catch(err => console.error('[Jobs] local OCR lease renewal failed:', err.message));
  }, 25_000) : null;
  heartbeat?.unref?.();
  const fail = error => set({ status: 'failed', stage: 'failed', errorStage: stage, error, finishedAt: new Date(), elapsedMs: Date.now() - startedAt });
  const deferForQuota = (error, retryAt) => set({
    status: 'queued', stage: 'retrying', retryStage: stage, lastError: error,
    attempts: 0, leaseUntil: null, error: null,
    nextAttemptAt: new Date(Math.max(Date.now() + 1000, Number(retryAt) || Date.now() + 60_000)),
  });
  // Retry in a fresh bounded request, including a slow transient OCR timeout.
  const retryOrFail = (error, retryable) => retryable && item.attempts < MAX_ATTEMPTS
    ? set({ status: 'queued', stage: 'retrying', retryStage: stage, lastError: error, leaseUntil: null, error: null })
    : fail(error);
  try {
    await set({ stage: 'downloading', progress: STAGE_PROGRESS.downloading });
    const ref = { path: item.storagePath, driver: item.storageDriver, mimeType: item.mimeType, size: item.size };
    const buffer = await getObject(ref, { deadline: startedAt + AI_BUDGET_MS });
    if (!buffer) return await fail('The uploaded file could not be found. Please upload it again.');
    if (buffer.length > maxUploadBytes()) return await fail(`File is too large. Maximum size is ${Math.round(maxUploadBytes() / 1024 / 1024)} MB.`);
    const owner = job.userId ? { _id: job.userId } : job.guestId ? { guestId: job.guestId } : null;
    const fileType = detectFileType(buffer, { originalname: item.filename, mimetype: item.mimeType }, { maxBytes: maxUploadBytes() });
    const process = fileType.kind === 'pdf' ? processPdfChunk : processDocument;
    const result = await process(
      { buffer, originalname: item.filename, mimetype: item.mimeType, size: buffer.length },
      {
        owner,
        maxBytes: maxUploadBytes(),
        requirePersistence: true,
        deadline: startedAt + AI_BUDGET_MS,
        checkpoint: item.checkpoint,
        saveCheckpoint: checkpoint => set({ checkpoint, status: 'queued', stage: 'extracting', attempts: 0, leaseUntil: null,
          pageProgress: { ...pageProgress, pagesCompleted: checkpoint.nextPage },
          progress: Math.round(90 * checkpoint.nextPage / checkpoint.pageCount) }),
        fileRef: { ...ref, size: buffer.length },
        quality: item.quality,
        onPageProgress: pages => set({ pageProgress: pages }),
        onStage: stage => {
          const phase = STAGE_PROGRESS[stage] ?? 50;
          const progress = pageProgress?.chunkCount > 1
            ? Math.round(90 * (pageProgress.pagesCompleted + (pageProgress.pageEnd - pageProgress.pageStart + 1) * phase / 100) / pageProgress.pageCount)
            : phase;
          return set({ stage, progress });
        },
      },
    );
    if (result.pending) return;
    if (isPrivacyMode()) await deleteObject(ref);
    if (!result.success) {
      // Keep the original: another job or saved document may still reference it.
      if (result.deferUntil) return await deferForQuota(result.error, result.deferUntil);
      return await retryOrFail(result.error, result.retryable);
    }
    await set({
      status: 'done', stage: 'done', progress: 100, checkpoint: null, documentId: result.id, cached: Boolean(result.cached),
      ...(pageProgress ? { pageProgress: { ...pageProgress, pagesCompleted: pageProgress.pageCount } } : {}),
      ...(result.warning ? { warning: result.warning } : {}), finishedAt: new Date(), elapsedMs: Date.now() - startedAt,
    });
    console.log(`[Jobs] ${item.filename}: ${result.docType}${result.cached ? ' (cached)' : ''} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error('[Jobs] item failed:', err.code || err.status || err.name);
    if (isGeminiRateLimit(err)) {
      await deferForQuota('Gemini quota is temporarily unavailable; this uploaded file will retry automatically.', err.retryAt);
      return;
    }
    const error = stage === 'downloading'
      ? 'The file was uploaded, but it could not be downloaded from storage. Please try again.'
      : 'Something went wrong while reading this file. Please try again.';
    await retryOrFail(error, Boolean(isTransientError(err))).catch(error => console.error('[Jobs] status update failed:', error.message));
  } finally { clearInterval(heartbeat); }
}

/** Overall state of a job from its items. */
export function jobStatus(job) {
  const s = job.items.map(i => i.status);
  if (s.some(x => x === 'queued' || x === 'running')) return 'running';
  if (s.every(x => x === 'done')) return 'done';
  if (s.every(x => x === 'failed')) return 'failed';
  return 'partial';
}

export function toJobResponse(job) {
  const items = job.items.map(i => ({
    id: i.id,
    filename: i.filename,
    size: i.size,
    status: i.status,
    processable: quotaReady(i) && (i.status === 'queued' || (i.status === 'running' && !leaseValid(i))),
    stage: i.stage,
    stageStartedAt: i.stageStartedAt,
    attempts: i.attempts ?? 0,
    ...(i.pageProgress ? { pageProgress: i.pageProgress } : {}),
    ...(i.errorStage ? { errorStage: i.errorStage } : {}),
    ...(i.retryStage ? { retryStage: i.retryStage } : {}),
    ...(i.lastError ? { lastError: i.lastError } : {}),
    progress: i.progress ?? 0,
    ...(i.error ? { error: i.error } : {}),
    ...(i.warning ? { warning: i.warning } : {}),
    ...(i.documentId ? { documentId: i.documentId } : {}),
    ...(i.cached ? { cached: true } : {}),
    ...(i.elapsedMs != null ? { elapsedMs: i.elapsedMs } : {}),
    ...(i.startedAt ? { startedAt: i.startedAt } : {}),
  }));
  const done = items.filter(i => i.status === 'done' || i.status === 'failed').length;
  return { id: String(job._id), createdAt: job.createdAt, status: jobStatus(job), done, total: items.length, items };
}

export { getJob };
