/**
 * One uploaded file → a saved document extraction. Shared by POST /api/extract
 * (synchronous, ≤ 4 MB) and the async job queue (jobs.js).
 *
 * validate (magic bytes) → cache lookup → text layer / OCR plan → one Gemini
 * call (or the rule-based fallback) → validation + confidence → save.
 */
import crypto from 'crypto';
import { isPrivacyMode } from './privacy.js';
import { redactDocument, maskerFor } from './redact.js';
import { asciiDigits } from './normalize.js';
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
import { analyzeGemini } from './geminiPipeline.js';
import { isGeminiRateLimit } from './geminiPool.js';
import { sortIssues } from './validate.js';
import { crossDocumentIssues } from './crossdoc.js';
import { buildEntityGraph } from './entityGraph.js';

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
  const { filename, fileHash, extractionVersion, mimeType, fileSize, source, model, warning, metadata, extraction, file, quality } = d;
  return { filename, fileHash, extractionVersion, mimeType, fileSize, source, model, warning, metadata, extraction: withoutReview(extraction), file, quality, graph: d.graph || null };
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
  const cached = privacy || deferSave ? null : await findExtractionByHash(fileHash, EXTRACTION_VERSION).catch(() => null);
  if (cached) {
    console.log('[Extract] cache hit', fileHash.slice(0, 12));
    let doc = cached;
    const sameOwner = owner && (owner._id ? String(cached.userId ?? '') === String(owner._id) : cached.guestId === owner.guestId && !cached.userId);
    if (!sameOwner && (owner || cached.userId || cached.guestId)) {
      // Give this owner their own copy so it shows up in their documents.
      doc = (await findUserExtractionByHash(fileHash, EXTRACTION_VERSION, owner).catch(() => null)) ||
        (await (async () => {
          const ref = (await storedRef()) || cached.file || null;
          return saveGraph({ ...pickStored(cached), filename, ...ownerFields(owner), file: ref, ...(quality ? { quality } : {}) });
        })().catch(err => { if (requirePersistence) throw err; return cached; }));
    }
    return toDocumentResponse(doc, { cached: true, filename });
  }

  await onStage('reading');
  const input = await prepareDocumentInput({ buffer: file.buffer, kind: fileType.kind, mimeType: fileType.mimeType });
  if (privacy && (fileType.kind === 'image' || input.mode !== 'text' || input.unreliablePages?.length)) {
    return failResult(filename, 422, 'Scanned document requires vision processing. Switch to Deep Intelligence Mode or upload a digital PDF.');
  }
  if (fileType.kind === 'image') await onPageProgress({ pageCount: 1, pagesCompleted: 0, pageStart: 1, pageEnd: 1, chunkIndex: 1, chunkCount: 1 });
  let result;
  let source = 'ai';
  let warning;
  if (pipeline === 'legacy') await onStage('extracting');
  try {
    if (privacy) {
      await onStage('extracting');
      result = fallbackExtract(input.pages);
      const identity = result.fields.find(f => f.key === 'id_number');
      if (identity?.value && /aadhaar|aadhar/i.test(input.pages.join(' '))) identity.format = 'aadhaar';
      else if (identity?.value && /^[A-Z]{5}\d{4}[A-Z]$/.test(identity.value.replace(/\s/g, ''))) identity.format = 'pan';
      source = 'fallback';
      warning = 'High-Privacy Mode: local parsing and validation with automated PII masking. This session is stored only in server memory and is lost on restart.';
    } else result = pipeline === 'legacy' ? await extractDocument(input, { deadline }) : await analyzeGemini({ ...input,
      // Keep original bytes available for selective re-verification of digital pages too.
      file: input.file || { data: file.buffer, mimeType: fileType.mimeType },
    }, { deadline, onStage, pageOffset });
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
    if (isGeminiRateLimit(err)) return failResult(filename, 429,
      'Gemini is rate-limited. Your uploaded file is retained and will retry when quota is available.',
      { retryable: true, deferUntil: Number(err.retryAt) || Date.now() + 60_000 });
    const what = fileType.kind === 'image' ? 'This image needs OCR' : 'This PDF has no selectable text';
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
    warning = err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic rule-based extraction was done.'
      : 'The AI service is busy right now, so a basic rule-based extraction was done. Upload again later for a full AI extraction.';
  }

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
    filename,
    fileHash,
    extractionVersion: EXTRACTION_VERSION,
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
    const mask = maskerFor([doc]).text;
    const redacted = redactDocument({ ...doc.extraction, filename: doc.filename });
    const sweep = value => typeof value === 'string' ? mask(asciiDigits(value)).replace(/\d{4}[\s_-]?\d{4}[\s_-]?\d{4}/g, v => `XXXX XXXX ${v.replace(/\D/g, '').slice(-4)}`).replace(/[A-Z]{5}\d{4}[A-Z]/gi, v => v.replace(/\d/g, 'X')).replace(/(?<!\d)\d{10}(?!\d)/g, v => `XXXXXX${v.slice(-4)}`)
      : Array.isArray(value) ? value.map(sweep) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sweep(v)])) : value;
    doc.filename = sweep(redacted.filename);
    doc.extraction = sweep({ ...doc.extraction, ...redacted, rawTextByPage: doc.extraction.rawTextByPage });
    doc.metadata = sweep(doc.metadata);
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
