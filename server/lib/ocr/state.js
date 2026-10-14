/** Derive the queue from current fields after extraction, masking or review. */
export const needsReview = fields => fields.filter(f => f.status === 'needs_review').map(f => ({
  field: f.key, label: f.label, candidates: f.candidates || [], confidence: f.ocr?.confidence ?? 0,
  threshold: f.ocr?.threshold, page: f.page, box: f.box || f.ocr?.reprocess?.region || null, reasons: f.ocr?.reasons || [],
}));
