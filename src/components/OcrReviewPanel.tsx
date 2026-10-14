import type { DocumentResult, ExtractedField } from '../types';
import { percent } from '../lib/api';

/** The existing field review form owns persistence and its audit trail. */
export function OcrReviewQueue({ doc, onSelectField }: { doc: DocumentResult; onSelectField: (key: string) => void }) {
  if (!doc.ocr) return null;
  const pending = doc.needs_review || [];
  const failures = doc.ocr.pages.flatMap(p => p.engines.filter(e => e.status === 'failed').map(e => `Page ${p.page}: ${e.engine}`));
  return (
    <section className="bg-white p-6 rounded-[32px] border border-amber-200 space-y-3" data-testid="ocr-review-queue">
      <h3 className="font-headline text-xl font-bold">OCR review · {pending.length} pending</h3>
      <p className="text-xs text-on-surface-variant">Agreement between engines supports a reading; it does not guarantee correctness. Unresolved readings are withheld until you review them.</p>
      {failures.length > 0 && <p className="text-xs text-amber-700">An OCR engine was unavailable: {failures.join('; ')}.</p>}
      <ul className="space-y-2">
        {pending.map(item => (
          <li key={item.field}>
            <button type="button" className="w-full text-left rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm break-words"
              onClick={() => onSelectField(item.field)} data-testid="ocr-review-item">
              <span className="font-bold">{item.label}</span> · OCR confidence {percent(item.confidence)}
              {item.page && <span> · Page {item.page}</span>}
              <span className="block text-xs mt-1">{item.reasons.map(reason => reason.replace(/_/g, ' ')).join(', ')}. Select to review candidates.</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OcrCandidates({ field, onChoose }: { field: ExtractedField; onChoose?: (value: string) => void }) {
  if (!field.ocr) return null;
  return (
    <div className="space-y-2" data-testid="ocr-candidates">
      <p className="text-xs font-bold">{field.ocr.manualReview ? 'Manually reviewed' : field.status === 'needs_review' ? 'Needs manual review' : field.status === 'reprocessed' ? 'Accepted after reprocessing' : 'OCR engines agreed'}</p>
      <p className="text-xs text-on-surface-variant">OCR confidence {percent(field.ocr.confidence)} · threshold {percent(field.ocr.threshold)} · agreement {field.agreement ? 'yes' : 'no'}</p>
      {field.validation && <p className="text-xs text-on-surface-variant">Validation: {field.validation.passed === null ? 'not evaluated' : field.validation.passed ? 'passed' : 'needs review'}{field.validation.rules.length > 0 ? ` (${field.validation.rules.join(', ')})` : ''}.</p>}
      {(field.candidates || []).map((candidate, i) => (
        <div key={i} className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1 break-words">
          <p className="font-bold">{candidate.engine}{candidate.engine === 'validator' ? ' (value checked by validation)' : candidate.role === 'extraction' ? ' (provisional extractor reading)' : candidate.attempt ? ' · reprocessed' : ' · original OCR'}</p>
          <p className="font-mono">{candidate.value ?? 'No reading available'}</p>
          <p>{candidate.confidence == null ? 'Confidence unavailable' : `${percent(candidate.confidence)} confidence`}{candidate.confidenceGranularity ? ` (${candidate.confidenceGranularity})` : ''}</p>
          {onChoose && candidate.value != null && <button type="button" className="text-primary font-bold py-1" onClick={() => onChoose(candidate.value!)}>Review this candidate</button>}
        </div>
      ))}
      {field.ocr.majorityHint && <p className="text-xs text-amber-700">Majority hint: {field.ocr.majorityHint.value}. This remains unresolved and is not a correctness guarantee.</p>}
      {field.box && <p className="text-xs text-on-surface-variant">Source region: [{field.box.join(', ')}] on page {field.page}. {field.status === 'needs_review' ? 'Compare it with the source before saving a correction.' : ''}</p>}
    </div>
  );
}
