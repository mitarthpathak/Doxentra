/**
 * One uploaded file → a saved document extraction. Shared by POST /api/extract
 * (synchronous, ≤ 4 MB) and the async job queue (jobs.js).
 *
 * validate (magic bytes) → cache lookup → text layer / OCR plan → one Gemini
 * call (or the rule-based fallback) → validation + confidence → save.
 */
import crypto from 'crypto';
import { isPrivacyMode } from './privacy.js';
import { maskPrivacyDocument } from './privacyDocument.js';
import { EXTRACTION_VERSION, extractDocument, fallbackExtract } from './extract.js';
import { detectFileType } from './files.js';
import { SCANNED_CHARS_PER_PAGE, prepareDocumentInput } from './pdfText.js';
import { findExtractionByHash, findUserExtractionByHash, saveGraph, listDocuments } from './db.js';
import { finalizeExtraction } from './pipeline.js';
import { textLayerPagesFor, overallConfidence } from './confidence.js';
import { toDocumentResponse } from './documentView.js';
import { ownerFields } from './owner.js';
import { withoutReview } from './review.js';
import { isTransientError } from './serviceErrors.js';
import { analyzeGemini, maskPrivateIds } from './geminiPipeline.js';
import { recognizeImageBuffer, recognizeScannedPdf } from './offlineOcr.js';
import { isGeminiRateLimit } from './geminiPool.js';
import { sortIssues } from './validate.js';
import { crossDocumentIssues } from './crossdoc.js';
import { buildEntityGraph } from './entityGraph.js';
import { ocrConfig, ocrConfigHash } from './ocr/config.js';
import { crosscheckExtraction, readOcrInput } from './ocr/crosscheck.js';

// Page text kept for search and quote verification.
const MAX_PAGE_CHARS = 20_000;
const MAX_STORED_TEXT_CHARS = 200_000;

function trimPages(pages) {
  let budget = MAX_STORED_TEXT_CHARS;
  return pages.map(p => {
    const text = String(p || '').slice(0, Math.min(MAX_PAGE_CHARS, Math.max(0, budget)));
    budget -= text.length;
    return text;
  });
}

export const failResult = (filename, status, error, extra = {}) => ({ success: false, filename, status, error, ...extra });

/** Fields copied when a cached extraction is saved for another owner (without its review or audit trail). */
function pickStored(d) {
  const { filename, fileHash, extractionVersion, ocrConfigHash, processingMode, mimeType, fileSize, source, model, warning, metadata, extraction, file, quality } = d;
  return { filename, fileHash, extractionVersion, ocrConfigHash, processingMode, mimeType, fileSize, source, model, warning, metadata, extraction: withoutReview(extraction), file, quality, graph: d.graph || null };
}

/**
 * Process one file. `file`: { buffer, originalname, mimetype, size }.
 * Options: owner (user record, { guestId } or null), deadline (ms timestamp
 * for the AI call), fileRef (where the original is stored: a reference, or an
 * async function that stores it on demand and returns the reference),
 * quality (image quality report from the browser), onStage(stage).
 * Resolves to a document response or failResult(); never throws for bad input.
 */
export async function processDocument(file, { owner = null, deadline, fileRef = null, quality = null, onStage = () => {}, onPageProgress = () => {}, deferSave = false, maxBytes, requirePersistence = false, pageOffset = 0, pipeline = process.env.DOXENTRA_ANALYSIS_PIPELINE || 'gemini' } = {}) {
  const filename = file.originalname || 'document';
  const privacy = isPrivacyMode();
  const config = ocrConfig();
  const configHash = ocrConfigHash(config);
  if (privacy) fileRef = null;
  let fileType;
  try {
    fileType = detectFileType(file.buffer, file, { maxBytes });
  } catch (err) {
    return failResult(filename, err.status || 400, err.message);
  }

  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storedRef = async () => {
    if (typeof fileRef !== 'function') return fileRef;
    return fileRef(fileType).catch(err => {
      console.error('[Extract] could not store the original file:', err.message);
      return null;
    });
  };
  const cached = privacy || deferSave ? null : await findExtractionByHash(fileHash, EXTRACTION_VERSION, configHash).catch(() => null);
  if (cached) {
    console.log('[Extract] cache hit', fileHash.slice(0, 12));
    let doc = cached;
    const sameOwner = owner && (owner._id ? String(cached.userId ?? '') === String(owner._id) : cached.guestId === owner.guestId && !cached.userId);
    if (!sameOwner && (owner || cached.userId || cached.guestId)) {
      // Give this owner their own copy so it shows up in their documents.
      doc = (await findUserExtractionByHash(fileHash, EXTRACTION_VERSION, owner, configHash).catch(() => null)) ||
        (await (async () => {
          const ref = (await storedRef()) || cached.file || null;
          return saveGraph({ ...pickStored(cached), filename, ...ownerFields(owner), file: ref, ...(quality ? { quality } : {}) });
        })().catch(err => { if (requirePersistence) throw err; return cached; }));
    }
    return toDocumentResponse(doc, { cached: true, filename });
  }

  await onStage('reading');
  const input = await prepareDocumentInput({ buffer: file.buffer, kind: fileType.kind, mimeType: fileType.mimeType });
  const ocrInput = { ...input, file: { data: file.buffer, mimeType: fileType.mimeType } };
  // Normal uploads use cloud OCR directly. Local OCR runs only for privacy,
  // provider failure, or an explicitly requested strict consensus review.
  const readConfig = config.strictReview ? config : { ...config, engines: ['tesseract'] };
  let recordsPromise;
  const localReads = () => recordsPromise ||= readOcrInput(ocrInput, { config: readConfig, deadline,
    onPage: async (_page, completed, count) => {
      if (privacy || fileType.kind === 'image') await onPageProgress({ pageCount: input.pageCount,
        pagesCompleted: input.pageCount - count + completed, pageStart: 1, pageEnd: input.pageCount, chunkIndex: 1, chunkCount: 1 });
    },
  });
  let records;
  if (config.enabled && config.strictReview) void localReads();
  if (privacy && config.enabled && (fileType.kind === 'image' || input.unreliablePages?.length)) {
    await onStage('local_ocr');
    records = await localReads();
    if (records.length && records.every(r => r.reads.every(read => read.status === 'failed')) && !input.pages.some(text => String(text).trim())) {
      return failResult(filename, 422, 'All configured local OCR engines failed. Please try a clearer image or check the OCR engine installation.');
    }
    input.pages = Array.from({ length: input.pageCount }, (_, i) =>
      records.find(r => r.page === i + 1)?.reads.find(r => r.status === 'ok' && r.text.trim())?.text || input.pages[i] || '');
    input.mode = 'text'; input.ocrUsed = true;
    input.textLayer = records.length === input.pageCount ? 'scanned' : 'mixed';
  } else if (privacy && (fileType.kind === 'image' || input.mode !== 'text' || input.unreliablePages?.length)) {
    await onStage('local_ocr');
    try {
      if (fileType.kind === 'image') {
        input.pages = [(await recognizeImageBuffer(file.buffer)).text];
        input.pageCount = 1;
        input.textLayer = 'scanned';
        input.unreliablePages = [1];
      } else {
        const pageNumbers = input.unreliablePages?.length
          ? input.unreliablePages
          : Array.from({ length: input.pageCount }, (_, i) => i + 1);
        const scanned = await recognizeScannedPdf(file.buffer, {
          pageNumbers,
          onPage: async (_page, completed) => onPageProgress({
            pageCount: input.pageCount, pagesCompleted: input.pageCount - pageNumbers.length + completed, pageStart: 1,
            pageEnd: input.pageCount, chunkIndex: 1, chunkCount: 1,
          }),
        });
        input.pages = Array.from({ length: input.pageCount }, (_, i) =>
          pageNumbers.includes(i + 1) ? scanned.pages[i] : input.pages[i] || '');
        input.textLayer = pageNumbers.length === input.pageCount ? 'scanned' : 'mixed';
      }
      input.mode = 'text';
      input.ocrUsed = true;
    } catch (err) {
      console.error('[Privacy] local OCR failed:', err.message);
      return failResult(filename, 422, 'Local OCR could not read this file. Please try a clearer scan or another image.');
    }
  }
  if (fileType.kind === 'image' && !config.enabled) await onPageProgress({ pageCount: 1, pagesCompleted: privacy ? 1 : 0, pageStart: 1, pageEnd: 1, chunkIndex: 1, chunkCount: 1 });
  let result;
  let source = 'ai';
  let warning;
  const needsOcr = fileType.kind === 'image' || input.unreliablePages?.length > 0;
  // Leave time to read the file locally if both cloud OCR providers fail.
  const cloudDeadline = config.enabled && !config.strictReview && needsOcr && Number.isFinite(deadline)
    ? deadline - Math.min(12_000, Math.max(0, (deadline - Date.now()) / 3)) : deadline;
  if (pipeline === 'legacy' && !privacy) await onStage('extracting');
  try {
    if (privacy) {
      await onStage('local_extract');
      result = fallbackExtract(input.pages, { local: true });
      const identity = result.fields.find(f => f.key === 'id_number');
      if (identity?.value && /aadhaar|aadhar/i.test(input.pages.join(' '))) identity.format = 'aadhaar';
      else if (identity?.value && /^[A-Z]{5}\d{4}[A-Z]$/.test(identity.value.replace(/\s/g, ''))) identity.format = 'pan';
      source = 'fallback';
      warning = 'High-Privacy Mode: local OCR, parsing and validation with automated PII masking. This session is stored only in server memory and is lost on restart.';
    } else result = pipeline === 'legacy' ? await extractDocument(input, { deadline: cloudDeadline }) : await analyzeGemini({ ...input,
      // Keep original bytes available for selective re-verification of digital pages too.
      file: input.file || { data: file.buffer, mimeType: fileType.mimeType },
    }, { deadline: cloudDeadline, onStage, pageOffset });
    if (result.pipeline?.fallback) {
      source = 'fallback';
      warning = result.pipeline.groqOcrPages
        ? result.pipeline.geminiOcrQuotaReached
          ? 'Gemini OCR limit reached. Groq read the image; a basic extraction is shown while Gemini analysis is unavailable.'
          : 'Gemini OCR was unavailable. Groq read the image; a basic extraction is shown while Gemini analysis is unavailable.'
        : 'Text was read successfully, but AI analysis is temporarily unavailable. A basic extraction is shown; upload again later for full analysis.';
    } else if (result.pipeline?.groqOcrPages) {
      warning = result.pipeline.geminiOcrQuotaReached
        ? 'Gemini OCR reached its limit. Groq read the image, and Gemini completed the analysis.'
        : 'Gemini OCR was unavailable. Groq read the image, and Gemini completed the analysis.';
    }
  } catch (err) {
    console.error('[Extract] AI extraction failed:', err.code || err.status || err.name);
    records ||= await localReads();
    if (err.code === 'OCR_PROVIDERS_FAILED' && err.groqStatus === 429 &&
      !records.some(r => r.reads.some(read => read.status === 'ok' && read.text.trim()))) return failResult(filename, 429,
      'OCR services are rate-limited. Your uploaded file is retained and will retry when quota is available.',
      { retryable: true, deferUntil: Number(err.retryAt) || Date.now() + 60_000 });
    if (isGeminiRateLimit(err) && !records.some(r => r.reads.some(read => read.status === 'ok' && read.text.trim()))) return failResult(filename, 429,
      'Gemini is rate-limited. Your uploaded file is retained and will retry when quota is available.',
      { retryable: true, deferUntil: Number(err.retryAt) || Date.now() + 60_000 });
    const what = fileType.kind === 'image' ? 'This image needs OCR' : 'This PDF has no selectable text';
    if (needsOcr) {
      const localPages = Array.from({ length: input.pageCount }, (_, i) =>
        records.find(r => r.page === i + 1)?.reads.find(r => r.status === 'ok' && r.text.trim())?.text || input.pages[i] || '');
      if (config.enabled && localPages.some(text => text.trim())) {
        input.pages = localPages; input.mode = 'text'; input.ocrUsed = true;
      }
    }
    if (input.mode !== 'text') {
      const error = err.code === 'NO_API_KEY'
        ? `${what} and the AI service is not configured.`
        : err.code === 'OCR_PROVIDERS_FAILED'
          ? `${what}, but both Gemini and Groq OCR failed. Please upload the file again shortly or contact the app administrator.`
        : err.code === 'AI_QUOTA_EXHAUSTED'
          ? `${what}, but the AI service's quota is exhausted. Please try again after its quota resets.`
        : err.status === 401 || err.status === 403
          ? `${what}, but the AI service's credentials were rejected. Please contact the app administrator.`
          : err.status === 400
            ? `${what}, but the AI service could not process this file. Please try a different file or contact the app administrator.`
            : `${what} and the AI service is busy right now. Please try again in a minute.`;
      return failResult(filename, 422, error, { retryable: err.code !== 'AI_QUOTA_EXHAUSTED' && Boolean(isTransientError(err) || err.code === 'BAD_AI_OUTPUT') });
    }
    result = fallbackExtract(input.pages);
    source = 'fallback';
    warning = records.some(r => r.reads.some(read => read.status === 'ok' && read.text.trim()))
      ? 'Cloud OCR was unavailable. Local OCR read the document; a basic extraction is shown.'
      : err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic rule-based extraction was done.'
      : 'The AI service is busy right now, so a basic rule-based extraction was done. Upload again later for a full AI extraction.';
  }

  if (config.enabled && config.strictReview) {
    records ||= await localReads();
    result = await crosscheckExtraction(result, ocrInput, { config, deadline, onStage, records });
  }
  // Cross-check candidates must follow the existing Aadhaar storage policy too.
  if (!privacy && config.enabled) result = maskPrivateIds(result, input.pages).result;
  await onStage('validating');
  const { model, ocrText, pipeline: analysis, conceptMap, ...rawExtraction } = result;
  if (analysis?.visionPageNumbers?.length) input.ocrUsed = true;
  const textLayerPages = analysis ? Array.from({ length: input.pageCount }, (_, i) => !analysis.visionPageNumbers.includes(i + 1))
    : textLayerPagesFor(input.pages, input.pageCount, input.ocrUsed, input.unreliablePages);
  // Text used for search and source-quote checks: the PDF text layer, or the
  // model's transcription for scans and photos.
  const ocrPage = n => (ocrText || []).find(p => p.page === n)?.text || '';
  const textByPage = Array.from({ length: input.pageCount }, (_, i) => {
    const layer = input.pages[i] || '';
    const usable = layer.replace(/\s/g, '').length >= SCANNED_CHARS_PER_PAGE && !(input.unreliablePages || []).includes(i + 1);
    return analysis?.textByPage?.[i] ?? (usable ? layer : ocrPage(i + 1) || layer);
  });
  const extraction = finalizeExtraction(rawExtraction, {
    textByPage,
    ocrUsed: input.ocrUsed,
    textLayerPages,
    quality,
  });
  if (analysis?.checksumIssues?.length) {
    extraction.issues = sortIssues([...extraction.issues, ...analysis.checksumIssues]);
    extraction.overallConfidence = overallConfidence(extraction.fields, extraction.issues);
  }
  const doc = {
    processingMode: privacy ? 'privacy' : 'deep',
    filename,
    fileHash,
    extractionVersion: EXTRACTION_VERSION,
    ocrConfigHash: configHash,
    mimeType: fileType.mimeType,
    fileSize: file.size ?? file.buffer.length,
    source,
    model,
    ...(warning ? { warning } : {}),
    ...ownerFields(owner),
    graph: conceptMap?.graph || null,
    metadata: conceptMap?.metadata || { title: extraction.title, description: extraction.summary, category: extraction.docTypeLabel },
    ...(quality ? { quality } : {}),
    extraction: {
      ...extraction,
      ocrUsed: input.ocrUsed,
      textLayer: input.textLayer,
      pageCount: input.pageCount,
      rawTextByPage: trimPages(textByPage),
    },
  };
  if (privacy) {
    Object.assign(doc, maskPrivacyDocument(doc));
    console.log(`[Privacy] local parsing complete pages=${input.pageCount}`);
  }
  // Keep the crosscheck/entity-graph route shapes and owner boundary. These
  // deterministic Stage 2 derivations are recomputed by those routes after edits.
  if (pipeline !== 'legacy' && owner && !deferSave) {
    const started = Date.now();
    const previous = await listDocuments(owner, 300);
    const workspace = [...previous, { ...doc, _id: fileHash }];
    const mismatches = crossDocumentIssues(workspace, { documentId: fileHash });
    const entities = buildEntityGraph(workspace);
    console.log(`[Gemini] stage2.workspace ${Date.now() - started}ms conflicts=${mismatches.length} nodes=${entities.nodes.length}`);
  }
  if (deferSave) return { success: true, doc, rawExtraction, checksumIssues: analysis?.checksumIssues || [], textLayerPages, warning };
  await onStage('saving');
  const ref = await storedRef();
  if (ref) doc.file = ref;
  let saved;
  try {
    saved = await saveGraph(doc);
  } catch (err) {
    if (requirePersistence) throw err;
    // Legacy synchronous callers can still receive the result if persistence fails.
    console.error('[Extract] could not save document:', err.message);
    saved = { ...doc, _id: crypto.randomUUID(), createdAt: new Date() };
  }
  return toDocumentResponse(saved, warning ? { warning } : {});
}
