import { openPdfRenderer } from '../pdfRender.js';
import { normalizeValue } from '../normalize.js';
import { ocrConfig } from './config.js';
import { runOcrEngines } from './runner.js';
import { candidateFor, unionBox } from './fieldCandidates.js';
import { compareCandidates, valuesAgree } from './agreement.js';
import { preprocessRegion } from './preprocess.js';

export const ocrPages = input => input.file?.mimeType !== 'application/pdf' ? [1]
  : (input.unreliablePages || (input.ocrUsed ? Array.from({ length: input.pageCount }, (_, i) => i + 1) : []));

/** Read each image once with all configured engines. Text remains provisional
 * until field alignment; failures are returned as evidence rather than thrown.
 */
export async function readOcrInput(input, { config, deadline = Infinity, dependencies = {}, onPage = async () => {} }) {
  if (!config.enabled) return [];
  const pages = ocrPages(input);
  if (!pages.length) return [];
  let renderer;
  const records = [];
  try {
    if (input.file?.mimeType === 'application/pdf') renderer = await (dependencies.openPdfRenderer || openPdfRenderer)(input.file.data);
    for (const page of pages) {
      if (Date.now() >= deadline) {
        records.push(...pages.slice(records.length).map(page => ({ page,
          reads: config.engines.map(engine => ({ engine, status: 'failed', error: 'OCR_TIMEOUT', text: '', words: [], lines: [] })) })));
        break;
      }
      const image = renderer ? await renderer.render(page) : input.file;
      const reads = await (dependencies.runOcrEngines || runOcrEngines)(image, { config, deadline });
      records.push({ page, reads });
      await onPage(page, records.length, pages.length);
    }
    return records;
  } catch {
    console.warn('[OCR] initial image preparation failed');
    return pages.map(page => records.find(r => r.page === page) || { page,
      reads: config.engines.map(engine => ({ engine, status: 'failed', error: 'OCR_IMAGE_FAILED', text: '', words: [], lines: [] })) });
  } finally { try { await renderer?.close(); } catch { console.warn('[OCR] renderer cleanup failed'); } }
}

/** Add OCR evidence without altering digital PDF fields or the extractor API.
 * Primary model/rule output is provisional evidence, never an independent vote.
 */
export async function crosscheckExtraction(extraction, input, { config = ocrConfig(), deadline = Infinity,
  onStage = async () => {}, dependencies = {}, records = null } = {}) {
  if (!config.enabled) return extraction;
  const pages = ocrPages(input);
  if (!pages.length) return extraction;
  const run = dependencies.runOcrEngines || runOcrEngines;
  const preprocess = dependencies.preprocessRegion || preprocessRegion;
  let renderer;
  const imageFor = async page => {
    if (input.file?.mimeType !== 'application/pdf') return input.file;
    renderer ||= await (dependencies.openPdfRenderer || openPdfRenderer)(input.file.data);
    return renderer.render(page);
  };
  const result = { ...extraction, fields: extraction.fields.map(f => ({ ...f })) };
  const evidence = [];
  let reprocessed = 0;
  try {
    await onStage('ocr_crosscheck');
    for (const page of pages) {
      let image;
      let reads;
      try {
        reads = records?.find(record => record.page === page)?.reads;
        if (!reads) { image = await imageFor(page); reads = await run(image, { config, deadline }); }
      } catch {
        reads = config.engines.map(engine => ({ engine, status: 'failed', error: 'OCR_IMAGE_FAILED', text: '', words: [], lines: [] }));
        console.warn(`[OCR] page=${page} image unavailable`);
      }
      evidence.push({ page, engines: reads.map(({ engine, status, error, elapsedMs, confidenceGranularity }) =>
        ({ engine, status, ...(error ? { error } : {}), elapsedMs, confidenceGranularity })) });
      const fields = result.fields.filter(f => f.page === page || (!f.page && (pages.length === 1 || f.value == null)));
      for (const field of fields) {
        let candidates = reads.map(read => candidateFor(field, read, { docType: result.docType, page }));
        if (field.value == null && candidates.every(c => c.value == null)) continue;
        const initial = candidates;
        let comparison = compareCandidates(field, candidates, config);
        const original = field.value == null ? [] : [{ engine: 'extraction', role: 'extraction', value: field.value,
          confidence: field.modelConfidence ?? null, page, box: field.box || null, attempt: 0 }];
        const differsFromExtraction = () => field.value != null && candidates.some(c => c.value != null && !valuesAgree(field, field.value, c.value, config));
        if (differsFromExtraction()) comparison.reasons.push('extraction_disagreement');
        const box = field.box || unionBox(candidates.map(c => c.box));
        let retry = null;
        if ((!comparison.accepted || comparison.reasons.length) && config.reprocess && reprocessed < config.maxReprocessFields && deadline - Date.now() > 250) {
          reprocessed++;
          await onStage('ocr_reprocessing');
          try {
            image ||= await imageFor(page);
            const crop = await preprocess(image, box);
            const reruns = await run(crop, { config, deadline });
            candidates = reruns.map(read => candidateFor(field, read, { docType: result.docType, page, cropped: Boolean(box), region: crop.region, attempt: 1 }));
            comparison = compareCandidates(field, candidates, config);
            // Reprocessing may correct an earlier provisional extractor reading;
            // acceptance still requires two independent, confident re-reads.
            retry = { attempted: true, steps: crop.steps, region: crop.region };
          } catch {
            comparison.reasons.push('reprocess_failed');
            retry = { attempted: true, error: 'OCR_REPROCESS_FAILED' };
          }
        } else if (!comparison.accepted || comparison.reasons.length) {
          comparison.reasons.push(config.reprocess ? 'reprocess_budget_exhausted' : 'reprocess_disabled');
        }
        const accepted = comparison.accepted && comparison.reasons.length === 0;
        const state = retry?.attempted && accepted ? 'reprocessed' : accepted ? 'accepted' : 'needs_review';
        const history = retry?.attempted ? [...original, ...initial, ...candidates] : [...original, ...candidates];
        const selected = accepted ? (retry?.attempted ? candidates[0].value : field.value ?? candidates[0].value) : null;
        Object.assign(field, { field: field.key, value: selected, normalizedValue: selected == null ? null : normalizeValue(field, selected, null),
          steps_applied: [...new Set([extraction.model?.startsWith('gemini') ? 'gemini' : 'extraction', ...reads.map(r => r.engine), ...(retry?.attempted ? ['rescan'] : [])])],
          ...(accepted && retry?.attempted ? { sourceQuote: candidates[0].sourceQuote || selected } : {}),
          page, ...(box ? { box } : {}), candidates: history, agreement: comparison.agreement, agreementState: comparison.agreementState,
          status: state, ocr: { confidence: comparison.confidence, threshold: comparison.threshold, reasons: [...new Set(comparison.reasons)],
            ...(comparison.majorityHint ? { majorityHint: comparison.majorityHint } : {}), ...(retry ? { reprocess: retry } : {}) },
        });
      }
    }
    // An unlocated OCR field cannot bypass review because it has no page number.
    for (const field of result.fields) if (field.value != null && !field.page && !field.ocr) {
      Object.assign(field, { field: field.key, candidates: [{ engine: 'extraction', role: 'extraction', value: field.value, confidence: field.modelConfidence ?? null }],
        value: null, normalizedValue: null, agreement: false, agreementState: 'uncertain', status: 'needs_review',
        ocr: { confidence: 0, threshold: config.confidenceThreshold, reasons: ['location_unavailable'] } });
    }
    result.ocr = { engines: config.engines, pages: evidence, reprocessedFields: reprocessed, validationEnabled: config.validation !== false, agreementIsGuarantee: false };
    return result;
  } catch {
    // Renderer setup failure is also reviewable; do not silently return accepted values.
    for (const field of result.fields) if (field.value != null && (!field.page || pages.includes(field.page))) {
      Object.assign(field, { candidates: [{ engine: 'extraction', role: 'extraction', value: field.value, confidence: field.modelConfidence ?? null }],
        value: null, normalizedValue: null, agreement: false, agreementState: 'uncertain', status: 'needs_review',
        ocr: { confidence: 0, threshold: config.confidenceThreshold, reasons: ['ocr_image_unavailable'] } });
    }
    console.warn('[OCR] cross-check image preparation failed');
    result.ocr = { engines: config.engines, pages: pages.map(page => ({ page,
      engines: config.engines.map(engine => ({ engine, status: 'failed', error: 'OCR_IMAGE_FAILED' })) })), reprocessedFields: reprocessed,
      validationEnabled: config.validation !== false, agreementIsGuarantee: false };
    return result;
  } finally { try { await renderer?.close(); } catch { console.warn('[OCR] renderer cleanup failed'); } }
}

export { needsReview } from './state.js';
