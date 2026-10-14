import crypto from 'crypto';
import { isPrivacyMode } from './privacy.js';
import { PDFDocument } from 'pdf-lib';
import { processDocument } from './processDocument.js';
import { saveGraph, findExtractionByHash } from './db.js';
import { EXTRACTION_VERSION } from './extract.js';
import { finalizeExtraction } from './pipeline.js';
import { toDocumentResponse } from './documentView.js';
import { sortIssues } from './validate.js';
import { overallConfidence } from './confidence.js';
import { listDocuments } from './db.js';
import { crossDocumentIssues } from './crossdoc.js';
import { buildEntityGraph } from './entityGraph.js';

export const PDF_CHUNK_PAGES = 5;

/** Merge citations in original page coordinates, retaining conflicting field values. */
export function mergeChunk(previous, result, offset) {
  const shift = entry => ({ ...entry, page: entry.page ? entry.page + offset : null });
  const raw = result.rawExtraction;
  const merged = previous ? structuredClone(previous) : {
    ...raw, fields: [], entities: [], tables: [], textByPage: [], textLayerPages: [], ocrUsed: false, graphChunks: [], checksumIssues: [],
  };
  if (previous && raw.summary && !merged.summary.includes(raw.summary)) merged.summary = `${merged.summary} ${raw.summary}`.slice(0, 4000);
  for (const field of raw.fields || []) {
    const value = shift(field);
    const existing = merged.fields.find(f => f.key === value.key);
    if (!existing) merged.fields.push(value);
    else if (existing.value == null && value.value != null) Object.assign(existing, value);
    else if (value.value != null && existing.value !== value.value) {
      merged.fields.push({ ...value, key: `${value.key}_page_${value.page || offset + 1}`, extra: true });
    }
  }
  for (const entity of raw.entities || []) {
    const value = shift(entity);
    if (!merged.entities.some(e => e.type === value.type && e.value === value.value && e.page === value.page)) merged.entities.push(value);
  }
  merged.tables.push(...(raw.tables || []).map(shift));
  merged.textByPage.push(...result.doc.extraction.rawTextByPage);
  merged.textLayerPages.push(...result.textLayerPages);
  merged.ocrUsed ||= result.doc.extraction.ocrUsed;
  merged.checksumIssues ||= [];
  merged.checksumIssues.push(...(result.checksumIssues || []));
  merged.graphChunks ||= [];
  if (result.doc.graph?.nodes?.length) merged.graphChunks.push({ graph: result.doc.graph, metadata: result.doc.metadata });
  return merged;
}

/** Join chunk concept trees under one root for the unchanged map/quiz contract. */
export function mergeConceptMaps(chunks) {
  if (!chunks.length) return null;
  const nodes = [];
  const edges = [];
  const root = { ...chunks[0].graph.nodes.find(n => n.type === 'major'), id: 'gemini-root', parentId: null };
  if (!root.label) return null;
  nodes.push(root);
  chunks.forEach(({ graph }, index) => {
    const ids = new Map(graph.nodes.map(n => [n.id, n.type === 'major' ? root.id : `c${index}-${n.id}`]));
    for (const node of graph.nodes) if (node.type !== 'major') nodes.push({ ...node, id: ids.get(node.id), parentId: ids.get(node.parentId) || root.id });
    for (const edge of graph.edges) edges.push({ ...edge, source: ids.get(edge.source), target: ids.get(edge.target) });
  });
  return { graph: { nodes, edges }, metadata: chunks[0].metadata };
}

/** Process only one bounded page range, then persist a continuation for the next request. */
export async function processPdfChunk(file, options) {
  if (isPrivacyMode()) return processDocument(file, options);
  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  if (!options.checkpoint && await findExtractionByHash(fileHash, EXTRACTION_VERSION)) return processDocument(file, options);
  await options.onStage?.('reading');
  const pdf = await PDFDocument.load(file.buffer);
  const pageCount = pdf.getPageCount();
  const offset = options.checkpoint?.nextPage || 0;
  const end = Math.min(offset + PDF_CHUNK_PAGES, pageCount);
  await options.onPageProgress?.({ pageCount, pagesCompleted: offset, pageStart: offset + 1, pageEnd: end,
    chunkIndex: Math.floor(offset / PDF_CHUNK_PAGES) + 1, chunkCount: Math.ceil(pageCount / PDF_CHUNK_PAGES) });
  if (pageCount <= PDF_CHUNK_PAGES) return processDocument(file, options);
  // Bound checkpoint size below MongoDB's document limit, without silently truncating pages.
  if (pageCount > 500) return { success: false, error: 'Please split PDFs longer than 500 pages before uploading.' };
  const checkpoint = options.checkpoint;
  if (checkpoint && checkpoint.fileHash !== fileHash) return { success: false, error: 'The uploaded file changed during processing. Please upload it again.' };
  const part = await PDFDocument.create();
  for (const page of await part.copyPages(pdf, Array.from({ length: end - offset }, (_, i) => offset + i))) part.addPage(page);
  const buffer = Buffer.from(await part.save({ useObjectStreams: false }));
  if (Date.now() > options.deadline - 5000) throw new Error('PDF preparation exceeded the processing budget');
  const result = await processDocument({ ...file, buffer, size: buffer.length }, { ...options, pageOffset: offset, fileRef: null, deferSave: true });
  if (!result.success) return result;
  const merged = mergeChunk(checkpoint?.merged, result, offset);
  if (Buffer.byteLength(JSON.stringify(merged)) > 800_000) return { success: false, error: 'This PDF contains too much extracted data. Please split it into smaller files.' };
  const fallback = checkpoint?.fallback || result.doc.source === 'fallback';
  const warning = checkpoint?.warning || result.warning;
  if (end < pageCount) {
    await options.saveCheckpoint({ nextPage: end, pageCount, fileHash, merged, fallback, warning });
    return { pending: true };
  }
  const { textByPage, textLayerPages, ocrUsed, graphChunks = [], checksumIssues = [], ...raw } = merged;
  await options.onStage?.('validating');
  const extraction = finalizeExtraction(raw, { textByPage, textLayerPages, ocrUsed, quality: options.quality });
  extraction.issues = sortIssues([...extraction.issues, ...checksumIssues]);
  extraction.overallConfidence = overallConfidence(extraction.fields, extraction.issues);
  const conceptMap = mergeConceptMaps(graphChunks);
  const doc = {
    ...result.doc, fileHash, fileSize: file.buffer.length, file: options.fileRef,
    ...(warning ? { warning } : {}),
    source: fallback ? 'fallback' : 'ai',
    graph: conceptMap?.graph || null,
    metadata: conceptMap?.metadata || { title: extraction.title, description: extraction.summary, category: extraction.docTypeLabel },
    extraction: { ...extraction, pageCount, ocrUsed, textLayer: ocrUsed ? 'mixed' : 'digital', rawTextByPage: textByPage },
  };
  if (options.owner && (options.pipeline || process.env.DOXENTRA_ANALYSIS_PIPELINE) !== 'legacy') {
    const started = Date.now();
    const workspace = [...await listDocuments(options.owner, 300), { ...doc, _id: fileHash }];
    const issues = crossDocumentIssues(workspace, { documentId: fileHash });
    const entityGraph = buildEntityGraph(workspace);
    console.log(`[Gemini] stage2.workspace ${Date.now() - started}ms conflicts=${issues.length} nodes=${entityGraph.nodes.length}`);
  }
  await options.onStage?.('saving');
  const saved = await saveGraph(doc);
  return toDocumentResponse(saved, warning ? { warning } : {});
}
