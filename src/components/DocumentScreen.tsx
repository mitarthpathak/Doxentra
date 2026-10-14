import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { getProcessingMode } from '../lib/processingMode';
import { apiFetch, confidenceBand, percent } from '../lib/api';
import { PagePreview } from './PagePreview';
import { IntegrityCard } from './IntegrityCard';
import { ApproveButton, FieldReview, ReviewHistory } from './ReviewPanel';
import { TwinPanel } from './TwinPanel';
import { LANGUAGE_NAMES, TranslationPanel, fetchTranslation, targetLanguage } from './TranslationPanel';
import type { CrossDocumentIssue, DocumentIssue, DocumentResult, DocumentTranslation, ExtractedEntity, ExtractedField, SourceFocus } from '../types';

// Existing palette: tertiary = good, amber = attention, red = problem.
export const BAND_STYLES = {
  high: 'bg-tertiary/10 text-tertiary border-tertiary/20',
  medium: 'bg-amber-50 text-amber-600 border-amber-100',
  low: 'bg-red-50 text-red-500 border-red-100',
} as const;

const SEVERITY = {
  error: { icon: 'error', text: 'text-red-500', box: 'bg-red-50 border-red-100' },
  warning: { icon: 'warning', text: 'text-amber-600', box: 'bg-amber-50 border-amber-100' },
  info: { icon: 'info', text: 'text-primary', box: 'bg-primary/5 border-primary/20' },
} as const;

const ISSUE_GROUPS: { type: DocumentIssue['type']; label: string }[] = [
  { type: 'missing', label: 'Missing' },
  { type: 'inconsistent', label: 'Inconsistent' },
  { type: 'format', label: 'Format' },
  { type: 'low_confidence', label: 'Low confidence' },
  { type: 'quality', label: 'Image quality' },
];

const ENTITY_ICONS: Record<string, string> = {
  PERSON: 'person', ORG: 'apartment', DATE: 'event', AMOUNT: 'payments', ID: 'badge',
  LOCATION: 'location_on', EMAIL: 'mail', PHONE: 'call', OTHER: 'label',
};

export function ConfidenceChip({ value, band, className }: { value: number | null | undefined; band?: string; className?: string }) {
  const b = (band as keyof typeof BAND_STYLES) || confidenceBand(value);
  return (
    <span
      className={cn('px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border whitespace-nowrap', BAND_STYLES[b], className)}
      title={`${b} confidence`}
    >
      {percent(value)} · {b}
    </span>
  );
}

/** How the type confidence was reached (tooltip on the type badge). */
function classificationNote(doc: DocumentResult) {
  const c = doc.classification;
  if (!c) return undefined;
  const parts = [`${doc.fallbackUsed ? 'Local rules' : 'AI'} ${percent(c.modelConfidence)}`];
  if (c.keywordShare != null) parts.push(`keywords ${percent(c.keywordShare)}`);
  parts.push(`required fields found ${percent(c.requiredCoverage)}`);
  return `${doc.docCategory ? `${doc.docCategory} · ` : ''}${parts.join(', ')}`;
}

// Exactly below Tailwind's lg (64rem), also at fractional widths under browser zoom.
const NARROW = '(width < 64rem)';

const display = (f: ExtractedField) => (f.value == null ? null : Array.isArray(f.normalizedValue) ? f.normalizedValue.join('; ') : f.value);

/** The quote with the field's value highlighted (when it occurs verbatim). */
function QuoteWithValue({ quote, value }: { quote: string; value: string | null }) {
  const i = value ? quote.toLowerCase().indexOf(value.toLowerCase()) : -1;
  if (!value || i < 0) return <>{quote}</>;
  return (
    <>
      {quote.slice(0, i)}
      <mark className="bg-primary/10 text-primary rounded px-0.5">{quote.slice(i, i + value.length)}</mark>
      {quote.slice(i + value.length)}
    </>
  );
}

interface DocumentScreenProps {
  doc: DocumentResult | null;
  recentDocs: DocumentResult[];
  selectedFieldKey: string | null;
  onSelectField: (key: string | null) => void;
  onSelectDoc: (doc: DocumentResult) => void;
  onUploadClick: () => void;
  onExport: (format: 'json' | 'csv') => Promise<void>;
  onBuildConceptMap: () => Promise<void>;
  onAsk: () => void;
  /** A cited passage to show when no field is selected. */
  focus?: SourceFocus | null;
  onClearFocus?: () => void;
  /** Open another document (from a cross-document issue), optionally at a field. */
  onOpenDocument?: (id: string, fieldKey: string | null) => Promise<void>;
  /** The document after a review action (confirm / correct / approve …). */
  onDocumentChange?: (doc: DocumentResult) => void;
  /** Personal data masked (doc is then the server's redacted copy). */
  masked?: boolean;
  onToggleMask?: () => void;
  onEntityGraph?: () => void;
}

export function DocumentScreen({ doc, recentDocs, selectedFieldKey, onSelectField, onSelectDoc, onUploadClick, onExport, onBuildConceptMap, onAsk, focus = null, onClearFocus = () => {}, onOpenDocument, onDocumentChange, masked = false, onToggleMask, onEntityGraph }: DocumentScreenProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => doc?.fields.find(f => f.key === selectedFieldKey) || null, [doc, selectedFieldKey]);

  // Below lg the page is one column: the source panel opens under the selected field
  // (a cited passage above the summary) instead of in the side column.
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    let t: ReturnType<typeof setTimeout>;
    // Settle first: a momentary viewport change (e.g. a full-page screenshot) moves nothing.
    const update = () => {
      clearTimeout(t);
      t = setTimeout(() => setNarrow(mq.matches), 200);
    };
    mq.addEventListener('change', update);
    return () => {
      clearTimeout(t);
      mq.removeEventListener('change', update);
    };
  }, []);

  // The panel is rendered once and its host node moved into whichever slot shows it,
  // so a correction being typed survives the layout switch.
  const [panelHost] = useState(() => {
    const el = document.createElement('div');
    el.style.display = 'contents';
    return el;
  });
  const panelSlot = useCallback((slot: HTMLDivElement | null) => {
    sourceRef.current = slot;
    if (slot && panelHost.parentNode !== slot) slot.appendChild(panelHost);
  }, [panelHost]);

  // Desktop: the side column scrolls to its top when a field or passage opens.
  useEffect(() => {
    if (!(selected || focus) || narrow) return;
    sideRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [selected, focus]);

  // Below lg: bring the opened field (or passage) into view, after the screen's own scroll to the top,
  // and again if the cross-document issues above it arrive just after and push it down.
  const scrollPending = useRef(false);
  const scrollToOpened = () => (rowRef.current ?? sourceRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  useEffect(() => {
    if (!narrow || !(selectedFieldKey || focus)) return;
    scrollPending.current = true;
    const t = setTimeout(scrollToOpened, 0);
    const settled = setTimeout(() => (scrollPending.current = false), 2500);
    return () => {
      clearTimeout(t);
      clearTimeout(settled);
      scrollPending.current = false;
    };
  }, [selectedFieldKey, focus, doc?.id]);

  useEffect(() => {
    setActionError(null);
  }, [doc?.id]);

  // Conflicts with the owner's other documents (same person or invoice described differently).
  const [crossIssues, setCrossIssues] = useState<CrossDocumentIssue[]>([]);
  useEffect(() => setCrossIssues([]), [doc?.id]);
  useEffect(() => {
    if (scrollPending.current && crossIssues.length) scrollToOpened();
  }, [crossIssues]);
  // A translation shown below the summary (closed when another document opens).
  const [translation, setTranslation] = useState<DocumentTranslation | null>(null);
  useEffect(() => setTranslation(null), [doc?.id, masked]);
  // Again after each review action: a corrected value can settle (or raise) a conflict.
  useEffect(() => {
    if (!doc?.id) return;
    let cancelled = false;
    apiFetch<{ issues: CrossDocumentIssue[] }>(`/crosscheck?documentId=${encodeURIComponent(doc.id)}${masked ? '&redact=1' : ''}`)
      .then(r => !cancelled && setCrossIssues(r.issues))
      .catch(() => { /* not saved for this owner (e.g. an older session result): nothing to compare */ });
    return () => { cancelled = true; };
  }, [doc?.id, doc?.auditCount, masked]);

  if (!doc) {
    return (
      <div className="py-8 space-y-8">
        <div>
          <p className="text-[10px] font-bold text-primary uppercase tracking-widest">Document Intelligence</p>
          <h2 className="text-4xl md:text-5xl font-headline font-bold">Extracted Information</h2>
        </div>
        <div className="text-center py-24 bg-surface-container-low rounded-[40px] border border-slate-200">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">plagiarism</span>
          <p className="text-slate-500 font-medium mb-5">No document yet. Upload a PDF, scan or photo to extract its information.</p>
          <button onClick={onUploadClick} className="px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90">
            Upload a Document
          </button>
        </div>
      </div>
    );
  }

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
    } catch (err: any) {
      setActionError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const found = doc.fields.filter(f => f.value != null);
  const privacy = doc.processingMode === 'privacy' || getProcessingMode() === 'privacy';
  const missingFields = doc.fields.filter(f => f.value == null);
  const visibleFields = showEmpty ? doc.fields : found.concat(missingFields.filter(f => f.required));
  const issueKeys = new Map<string, DocumentIssue['severity']>();
  for (const i of doc.issues) for (const k of i.fieldKeys) if (!issueKeys.has(k) || i.severity === 'error') issueKeys.set(k, i.severity);
  for (const i of crossIssues) {
    for (const r of i.refs) if (r.documentId === doc.id && r.fieldKey && (!issueKeys.has(r.fieldKey) || i.severity === 'error')) issueKeys.set(r.fieldKey, i.severity);
  }
  const entityGroups = doc.entities.reduce<Record<string, ExtractedEntity[]>>((acc, e) => {
    (acc[e.type] ||= []).push(e);
    return acc;
  }, {});
  const counts = { error: 0, warning: 0, info: 0, ...(doc.issueCounts || {}) };
  if (!doc.issueCounts) for (const i of doc.issues) counts[i.severity]++;
  for (const i of crossIssues) counts[i.severity]++;
  const otherTypes = (doc.typeCandidates || []).filter(c => c.docType !== doc.docType && c.confidence >= 0.05);

  // Below lg it moves with the selection, so it does not fade out under the next field.
  const sourcePanel = selected ? (
    <motion.div
      key={selected.key}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={narrow ? undefined : { opacity: 0 }}
      className={cn('bg-white rounded-[32px] border border-primary/20 shadow-sm space-y-5', narrow ? 'p-4 sm:p-6' : 'p-6 md:p-8')}
      data-testid="source-panel"
      aria-live="polite"
    >
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Source</p>
          <p className="text-xl font-headline font-bold mt-1 break-words">{selected.label}</p>
        </div>
        <button
          onClick={() => onSelectField(null)}
          aria-label="Close source panel"
          className="w-9 h-9 rounded-xl bg-surface-container-highest flex items-center justify-center hover:bg-primary hover:text-white transition-all shrink-0"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
      <div>
        <p className="text-sm font-medium break-words">{display(selected) ?? 'Not found in the document'}</p>
        {selected.transliteration && <p className="text-[10px] text-on-surface-variant mt-1" lang="en">In Latin letters: {selected.transliteration}</p>}
        {selected.normalizedValue != null && !Array.isArray(selected.normalizedValue) && String(selected.normalizedValue) !== selected.value && (
          <p className="text-[10px] text-on-surface-variant mt-1 break-words">Normalised: <span className="font-mono">{String(selected.normalizedValue)}</span></p>
        )}
      </div>
      {onDocumentChange && doc.review && <FieldReview doc={doc} field={selected} onChange={onDocumentChange} />}
      {doc.hasFile && selected.value != null && !masked && (
        <PagePreview docId={doc.id} page={selected.page} quote={selected.sourceQuote} value={selected.value} fieldKey={selected.key} box={selected.box} />
      )}
      {selected.sourceQuote ? (
        <blockquote className="border-l-4 border-primary bg-surface-container-low rounded-r-2xl px-4 py-3 text-sm text-on-surface leading-relaxed break-words">
          <QuoteWithValue quote={selected.sourceQuote} value={selected.value} />
        </blockquote>
      ) : (
        <p className="text-xs text-on-surface-variant italic">No source quote: this field was not found in the document.</p>
      )}
      <div className="flex flex-wrap gap-2 items-center">
        <ConfidenceChip value={selected.confidence} band={selected.confidenceBand} />
        {selected.page && (
          <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border bg-slate-100 text-slate-500 border-slate-200">Page {selected.page}</span>
        )}
        {selected.confidenceDetail?.source && (
          <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border bg-slate-100 text-slate-500 border-slate-200">
            {selected.confidenceDetail.source === 'ocr' ? 'Read by OCR' : 'PDF text layer'}
          </span>
        )}
      </div>
      {selected.confidenceDetail && selected.value != null && (
        <div className="space-y-2" aria-label="How the confidence was calculated">
          <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">How the confidence was calculated</p>
          {[
            ['AI certainty', selected.confidenceDetail.model, '50%'],
            ['Quote found in document', selected.confidenceDetail.verification, '30%'],
            ['Format & consistency checks', selected.confidenceDetail.validation, '20%'],
          ].map(([label, v, weight]) => (
            <div key={label as string}>
              <div className="flex justify-between text-[10px] text-on-surface-variant mb-1">
                <span>{label} <span className="opacity-60">× {weight}</span></span>
                <span className="font-mono">{percent(v as number)}</span>
              </div>
              <div className="h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style={{ width: percent(v as number) }} />
              </div>
            </div>
          ))}
          {selected.confidenceDetail.capped?.includes('ocr') && !selected.confidenceDetail.capped?.includes('image_quality') && (
            <p className="text-[10px] text-on-surface-variant">Capped at 90%: values read by OCR cannot be checked against a text layer.</p>
          )}
          {selected.confidenceDetail.capped?.includes('image_quality') && (
            <p className="text-[10px] text-amber-600 font-medium">Capped at 75%: the photo or scan is blurry, dark or faint (see Image quality).</p>
          )}
          {selected.confidenceDetail.capped?.includes('unverified') && (
            <p className="text-[10px] text-red-500 font-medium">Capped at 40%: neither the quote nor the value could be found in the document.</p>
          )}
        </div>
      )}
    </motion.div>
  ) : focus ? (
    <motion.div
      key={`focus-${focus.page}-${focus.quote}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={narrow ? undefined : { opacity: 0 }}
      className="bg-white p-6 md:p-8 rounded-[32px] border border-primary/20 shadow-sm space-y-5"
      data-testid="source-panel"
      aria-live="polite"
    >
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Source</p>
          <p className="text-xl font-headline font-bold mt-1 break-words">{focus.label || (focus.page ? `Page ${focus.page}` : 'Cited passage')}</p>
        </div>
        <button
          onClick={onClearFocus}
          aria-label="Close source panel"
          className="w-9 h-9 rounded-xl bg-surface-container-highest flex items-center justify-center hover:bg-primary hover:text-white transition-all shrink-0"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
      {doc.hasFile && focus.page && !masked && <PagePreview docId={doc.id} page={focus.page} quote={focus.quote} value={null} />}
      <blockquote className="border-l-4 border-primary bg-surface-container-low rounded-r-2xl px-4 py-3 text-sm text-on-surface leading-relaxed break-words">
        {focus.quote}
      </blockquote>
    </motion.div>
  ) : null;

  const issuesPanel = (
    <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-5" data-testid="issues-panel">
      <div className="flex flex-wrap lg:flex-nowrap justify-between items-center gap-x-4 gap-y-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Validation</p>
          <p className="text-xl font-headline font-bold mt-1">Issues</p>
        </div>
        <div className="flex flex-wrap lg:flex-nowrap gap-1.5">
          {(['error', 'warning', 'info'] as const).map(s => counts[s] > 0 && (
            <span key={s} className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase border', SEVERITY[s].box, SEVERITY[s].text)}>
              <span className="material-symbols-outlined text-[12px]">{SEVERITY[s].icon}</span>
              {counts[s]}
            </span>
          ))}
        </div>
      </div>
      {doc.issues.length === 0 && crossIssues.length === 0 ? (
        <div className={cn('flex items-center gap-3 text-sm font-medium', found.length ? 'text-tertiary' : 'text-amber-600')}>
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>{found.length ? 'check_circle' : 'warning'}</span>
          {found.length ? 'No issues detected in the extracted values. Review the source for completeness.' : 'No values were extracted. Consistency could not be checked.'}
        </div>
      ) : (
        ISSUE_GROUPS.map(group => {
          const list = doc.issues.filter(i => i.type === group.type);
          if (!list.length) return null;
          return (
            <div key={group.type} className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{group.label} · {list.length}</p>
              {list.map((issue, i) => {
                const s = SEVERITY[issue.severity];
                const target = issue.fieldKeys.find(k => doc.fields.some(f => f.key === k));
                const content = (
                  <>
                    <span className={cn('material-symbols-outlined text-lg shrink-0', s.text)}>{s.icon}</span>
                    <span className="text-xs text-on-surface leading-relaxed">
                      <span className={cn('font-bold uppercase text-[9px] tracking-widest mr-1.5', s.text)}>{issue.severity}</span>
                      {issue.message}
                    </span>
                  </>
                );
                return target ? (
                  <button
                    key={i}
                    onClick={() => onSelectField(target)}
                    className={cn('w-full text-left flex gap-3 items-start px-4 py-3 rounded-2xl border hover:shadow-sm transition-shadow', s.box)}
                    aria-label={`${issue.severity}: ${issue.message} Show field.`}
                    data-testid="issue-item"
                  >
                    {content}
                  </button>
                ) : (
                  <div key={i} className={cn('flex gap-3 items-start px-4 py-3 rounded-2xl border', s.box)} data-testid="issue-item">
                    {content}
                  </div>
                );
              })}
            </div>
          );
        }).concat(crossIssues.length ? [
          <div key="cross" className="space-y-2" data-testid="cross-issues">
            <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Across documents · {crossIssues.length}</p>
            {crossIssues.map((issue, i) => {
              const s = SEVERITY[issue.severity];
              const own = issue.refs.find(r => r.documentId === doc.id && r.fieldKey);
              const others = issue.refs.filter(r => r.documentId !== doc.id);
              return (
                <div key={i} className={cn('flex gap-3 items-start px-4 py-3 rounded-2xl border', s.box)} data-testid="issue-item">
                  <span className={cn('material-symbols-outlined text-lg shrink-0', s.text)}>{s.icon}</span>
                  <div className="text-xs text-on-surface leading-relaxed min-w-0">
                    <span className={cn('font-bold uppercase text-[9px] tracking-widest mr-1.5', s.text)}>{issue.severity}</span>
                    {issue.message}
                    <div className="flex flex-wrap gap-x-3 gap-y-0 mt-0.5 lg:gap-y-1 lg:mt-1.5">
                      {own && (
                        <button onClick={() => onSelectField(own.fieldKey)} className="text-[10px] font-bold text-primary uppercase tracking-widest hover:underline py-2 lg:py-0">
                          Show here
                        </button>
                      )}
                      {onOpenDocument && others.map(r => (
                        <button
                          key={`${r.documentId}-${r.fieldKey}`}
                          onClick={() => run('open', () => onOpenDocument(r.documentId, r.fieldKey))}
                          className="text-[10px] font-bold text-primary uppercase tracking-widest hover:underline text-left py-2 lg:py-0"
                          data-testid="cross-open"
                        >
                          Open {r.title} →
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>,
        ] : [])
      )}
    </div>
  );

  return (
    <div className="space-y-8 py-8" data-testid="document-screen">
      <IntegrityCard issues={crossIssues} onOpenDocument={onOpenDocument ? (id, key) => { void run('open', () => onOpenDocument(id, key)); } : undefined} onGraph={onEntityGraph} />
      {/* ─── Header ─────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4 w-full">
        <div className="min-w-0">
          <p className="text-[10px] font-bold text-primary uppercase tracking-widest">Document Intelligence</p>
          <h2 className="text-4xl md:text-5xl font-headline font-bold break-words">{doc.title || doc.filename}</h2>
          <div className="flex flex-wrap gap-2 mt-4" aria-label="Document properties">
            <span className="px-4 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase rounded-full border border-primary/20 tracking-widest" data-testid="doc-type-badge" title={classificationNote(doc)}>
              {doc.docTypeLabel} · {percent(doc.docTypeConfidence)}
            </span>
            {doc.docSubtypeLabel && (
              <span className="px-4 py-1 bg-slate-100 text-slate-500 text-[10px] font-black uppercase rounded-full border border-slate-200 tracking-widest" data-testid="doc-subtype-badge" title={doc.docCategory ? `Category: ${doc.docCategory}` : undefined}>
                {doc.docSubtypeLabel}
              </span>
            )}
            {doc.ocrUsed && (
              <span className="px-4 py-1 bg-secondary/10 text-secondary text-[10px] font-black uppercase rounded-full border border-secondary/20 tracking-widest" data-testid="ocr-badge" title="Text was read from the image with OCR">
                OCR
              </span>
            )}
            <span className="px-4 py-1 bg-slate-100 text-slate-500 text-[10px] font-black uppercase rounded-full border border-slate-200 tracking-widest">
              {doc.pageCount} {doc.pageCount === 1 ? 'Page' : 'Pages'}
            </span>
            {doc.language && (
              <span className="px-4 py-1 bg-slate-100 text-slate-500 text-[10px] font-black uppercase rounded-full border border-slate-200 tracking-widest">
                {doc.language}
              </span>
            )}
            {doc.fallbackUsed && (
              <span className="px-4 py-1 bg-amber-50 text-amber-600 text-[10px] font-black uppercase rounded-full border border-amber-100 tracking-widest">
                {privacy ? 'Local extraction' : 'Basic extraction'}
              </span>
            )}
            {doc.review && doc.review.status !== 'unreviewed' && (
              <span
                className={cn('px-4 py-1 text-[10px] font-black uppercase rounded-full border tracking-widest', doc.review.status === 'approved' ? 'bg-tertiary/10 text-tertiary border-tertiary/20' : 'bg-amber-50 text-amber-600 border-amber-100')}
                data-testid="review-badge"
                title={doc.review.approvedBy ? `Approved by ${doc.review.approvedBy}` : undefined}
              >
                {doc.review.status === 'approved' ? 'Approved' : `In review · ${doc.review.reviewed}/${doc.review.total}`}
              </span>
            )}
          </div>
          {otherTypes.length > 0 && (
            <p className="text-xs text-slate-400 mt-3" data-testid="type-candidates">
              Also possible: {otherTypes.map(c => `${c.label} ${percent(c.confidence)}`).join(' · ')}
            </p>
          )}
        </div>
        <div className="bg-surface-container-high px-8 py-4 rounded-[32px] border border-slate-200 shadow-sm text-center self-start md:self-auto shrink-0">
          <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Confidence</p>
          <p className={cn('text-3xl font-headline font-bold', confidenceBand(doc.overallConfidence) === 'high' ? 'text-tertiary' : confidenceBand(doc.overallConfidence) === 'medium' ? 'text-amber-600' : 'text-red-500')} data-testid="overall-confidence">
            {percent(doc.overallConfidence)}
          </p>
        </div>
      </div>

      {(doc.warning || doc.fallbackUsed) && (
        <div role="status" data-testid="document-processing-warning" className="px-5 py-3 bg-amber-50 border border-amber-100 rounded-2xl text-sm text-amber-700">
          {doc.warning || 'This is a basic rule-based extraction because the AI service was unavailable. Upload the document again later for a full AI extraction.'}
        </div>
      )}

      {/* ─── Actions and documents from this session ───────── */}
      <div className="flex flex-wrap items-center gap-2">
        {recentDocs.length > 1 && (
          // Phones: the session's documents scroll sideways in one line, above the actions.
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 w-[calc(100%+2rem)] md:contents">
            {recentDocs.map(d => (
              <button
                key={d.id}
                onClick={() => onSelectDoc(d)}
                aria-pressed={d.id === doc.id}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 lg:py-1.5 rounded-full text-[10px] font-bold uppercase transition-colors max-w-[220px] shrink-0 md:shrink',
                  d.id === doc.id ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'
                )}
              >
                <span className="material-symbols-outlined text-sm">description</span>
                {/* Masked: other documents' file names may name people, so show their type. */}
                <span className="truncate">{d.id === doc.id ? doc.filename : masked ? d.docTypeLabel : d.filename}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2 md:ml-auto">
          {onToggleMask && !privacy && (
            <button
              onClick={onToggleMask}
              aria-pressed={masked}
              className={cn(
                'flex items-center gap-2 px-3 py-2 lg:py-1.5 rounded-full text-[10px] font-bold uppercase transition-colors',
                masked ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              )}
              data-testid="mask-toggle"
            >
              <span className="material-symbols-outlined text-sm">{masked ? 'visibility' : 'visibility_off'}</span>
              {masked ? 'Show personal data' : 'Mask personal data'}
            </button>
          )}
          {onDocumentChange && doc.review && <ApproveButton doc={doc} onChange={onDocumentChange} onError={setActionError} />}
          {!masked && (
            <button
              onClick={() => run('translate', async () => setTranslation(await fetchTranslation(doc, targetLanguage(doc))))}
              disabled={!!busy || privacy}
              title={privacy ? 'Translation requires cloud AI and is unavailable in High-Privacy Mode.' : undefined}
              className="flex items-center gap-2 px-3 py-2 lg:py-1.5 bg-primary/10 rounded-full text-[10px] text-primary font-bold uppercase hover:bg-primary/20 transition-colors disabled:opacity-50"
              data-testid="translate"
            >
              <span className="material-symbols-outlined text-sm">translate</span>
              {busy === 'translate' ? 'Translating…' : `Translate to ${LANGUAGE_NAMES[targetLanguage(doc)]}`}
            </button>
          )}
          <button
            onClick={onAsk}
            className="flex items-center gap-2 px-3 py-2 lg:py-1.5 bg-primary/10 rounded-full text-[10px] text-primary font-bold uppercase hover:bg-primary/20 transition-colors"
            data-testid="ask-document"
          >
            <span className="material-symbols-outlined text-sm">forum</span>
            Ask this document
          </button>
          <button
            onClick={() => run('json', () => onExport('json'))}
            disabled={!!busy}
            className="flex items-center gap-2 px-3 py-2 lg:py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">data_object</span>
            {busy === 'json' ? 'Exporting…' : 'Export JSON'}
          </button>
          <button
            onClick={() => run('csv', () => onExport('csv'))}
            disabled={!!busy}
            className="flex items-center gap-2 px-3 py-2 lg:py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">table_view</span>
            {busy === 'csv' ? 'Exporting…' : 'Export CSV'}
          </button>
          <button
            onClick={() => run('map', onBuildConceptMap)}
            disabled={!!busy}
            className="flex items-center gap-2 px-3 py-2 lg:py-1.5 bg-secondary/10 rounded-full text-[10px] text-secondary font-bold uppercase hover:bg-secondary/20 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">account_tree</span>
            {busy === 'map' ? 'Building map…' : doc.hasGraph ? 'Open Concept Map' : 'Build Concept Map'}
          </button>
        </div>
      </div>
      {privacy && <p className="text-xs text-on-surface-variant">Personal data is masked automatically. Translation requires Deep Intelligence Mode.</p>}
      {masked && (
        <div className="px-5 py-3 bg-surface-container-low border border-slate-200 rounded-2xl text-sm text-on-surface-variant" data-testid="mask-banner">
          Personal data is masked{doc.redaction?.fields.length ? `: ${doc.redaction.fields.map(f => f.label).join(', ')}` : ''}. Exports are redacted too; page images and review are off while masking.
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-red-500 text-sm font-medium px-4 py-2 bg-red-50 rounded-lg border border-red-100">{actionError}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* ─── Left: summary, fields, tables, entities ──────── */}
        <div className="lg:col-span-7 space-y-8 min-w-0">
          {narrow && !selected && focus && <div ref={panelSlot} className="scroll-mt-24" />}
          <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant mb-4 opacity-50">Summary</p>
            <p className="text-on-surface leading-relaxed font-medium" data-testid="doc-summary">{doc.summary}</p>
            <p className="text-[10px] font-bold text-primary uppercase tracking-[0.2em] mt-4 truncate">{doc.filename}</p>
            {privacy && doc.textByPage && (
              <details className="mt-5 border-t border-slate-200 pt-4" data-testid="local-source-text">
                <summary className="cursor-pointer text-sm font-bold text-primary">View recognised text (personal data masked)</summary>
                <div className="mt-3 max-h-80 overflow-y-auto space-y-4">
                  {doc.textByPage.map((text, i) => (
                    <div key={i}>
                      <p className="text-xs font-bold text-on-surface-variant mb-2">Page {i + 1}</p>
                      <p className="text-sm whitespace-pre-wrap break-words">{text || 'No readable text found on this page.'}</p>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          {translation && <TranslationPanel translation={translation} onClose={() => setTranslation(null)} />}

          {!masked && <TwinPanel doc={doc} onDocumentChange={onDocumentChange} />}

          {narrow && issuesPanel}

          <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
            <div className="flex flex-wrap justify-between items-center mb-6 gap-x-4 gap-y-2">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Extracted Fields</p>
                <p className="text-xl font-headline font-bold mt-1">{found.length} of {doc.fields.length} found</p>
              </div>
              {missingFields.some(f => !f.required) && (
                <button
                  onClick={() => setShowEmpty(v => !v)}
                  aria-pressed={showEmpty}
                  className="text-[10px] font-bold text-primary uppercase tracking-widest hover:underline shrink-0 p-2.5 -m-2.5 lg:p-0 lg:m-0"
                >
                  {showEmpty ? 'Hide empty' : 'Show all fields'}
                </button>
              )}
            </div>
            <p className="text-[10px] text-on-surface-variant mb-3">Select a field to see where it was found.</p>
            <ul className="space-y-2" aria-label="Extracted fields" data-testid="fields-table">
              {visibleFields.map(f => {
                const value = display(f);
                const isSelected = f.key === selectedFieldKey;
                const flagged = issueKeys.get(f.key);
                return (
                  <li key={f.key} ref={narrow && isSelected ? rowRef : undefined} className="scroll-mt-24">
                    <button
                      onClick={() => onSelectField(isSelected ? null : f.key)}
                      aria-pressed={isSelected}
                      aria-label={`${f.label}: ${value ?? 'missing'}, ${percent(f.confidence)} confidence${f.page ? `, page ${f.page}` : ''}`}
                      className={cn(
                        'w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-3 gap-y-1 sm:gap-3 px-4 py-3 rounded-2xl border transition-all',
                        isSelected ? 'bg-surface-container-high border-primary/30' : 'bg-white border-slate-200 hover:border-primary/30'
                      )}
                      data-testid="field-row"
                    >
                      {/* Phones: label and confidence on top, the value below at full width; side by side from sm up. */}
                      <span className="contents">
                      <span className="min-w-0">
                        <span className="block text-[10px] font-bold uppercase tracking-wider text-on-surface-variant sm:truncate">
                          {f.label}{f.required && <span className="text-primary">{'\u00a0'}*</span>}
                        </span>
                        {flagged && (
                          <span className={cn('flex items-center gap-1 text-[9px] font-bold uppercase', SEVERITY[flagged].text)}>
                            <span className="material-symbols-outlined text-[12px]">{SEVERITY[flagged].icon}</span>
                            Check
                          </span>
                        )}
                      </span>
                      <span className={cn('col-span-2 sm:col-span-1 text-sm break-words min-w-0', value == null ? 'text-slate-400 italic' : 'font-medium text-on-surface')}>
                        {value ?? (f.required ? 'Missing' : 'Not found')}
                        {f.transliteration && <span className="block text-[10px] font-normal text-on-surface-variant mt-0.5" lang="en" data-testid="field-transliteration">{f.transliteration}</span>}
                      </span>
                      </span>
                      <span className="col-start-2 row-start-1 max-w-[7.5rem] flex flex-wrap items-center justify-end gap-x-2 gap-y-1 sm:col-auto sm:row-auto sm:max-w-none sm:flex-col sm:flex-nowrap sm:items-end sm:justify-start sm:gap-1">
                        <ConfidenceChip value={f.confidence} band={f.confidenceBand} />
                        {f.review && (
                          <span className="flex items-center gap-1 text-[9px] font-bold text-tertiary uppercase tracking-widest" data-testid="field-reviewed">
                            <span className="material-symbols-outlined text-[12px]">{f.review.status === 'confirmed' ? 'check_circle' : 'edit'}</span>
                            {f.review.status === 'confirmed' ? 'Verified' : 'Corrected'}
                          </span>
                        )}
                        {f.page && <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">p.{f.page}</span>}
                      </span>
                    </button>
                    {narrow && isSelected && <div ref={panelSlot} className="pt-2 -mx-3 sm:mx-0" />}
                  </li>
                );
              })}
            </ul>
            {narrow && selected && !visibleFields.includes(selected) && <div ref={panelSlot} className="pt-2 -mx-3 sm:mx-0 scroll-mt-24" />}
          </div>

          {doc.tables.map((t, ti) => (
            <div key={ti} className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <p className="text-xl font-headline font-bold">{t.title}</p>
                {t.page && <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">p.{t.page}</span>}
              </div>
              <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {t.columns.map((c, ci) => (
                        <th key={ci} className="text-left text-[10px] font-bold uppercase tracking-wider text-on-surface-variant px-3 py-2 border-b border-slate-200">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, ri) => (
                      <tr key={ri} className="border-b border-slate-100 last:border-0">
                        {r.map((cell, ci) => <td key={ci} className="px-3 py-2 text-on-surface">{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {doc.entities.length > 0 && (
            <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-5">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Entities</p>
              {Object.entries(entityGroups).map(([type, list]) => (
                <div key={type}>
                  <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-primary mb-2">
                    <span className="material-symbols-outlined text-sm">{ENTITY_ICONS[type] || 'label'}</span>
                    {type}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {list.map((e, i) => (
                      <span
                        key={i}
                        title={e.sourceQuote ? `“${e.sourceQuote}”${e.page ? ` (page ${e.page})` : ''}` : undefined}
                        className="px-3 py-1 bg-white rounded-full text-xs font-medium text-on-surface border border-slate-200"
                      >
                        {e.value}
                        {e.page && <span className="text-[9px] font-bold text-slate-400 ml-1.5">p.{e.page}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ─── Right: source panel and issues ───────────────── */}
        <div ref={sideRef} className="lg:col-span-5 space-y-8 lg:sticky lg:top-28 min-w-0 lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-[32px] lg:pb-2" data-testid="side-column">
          {!narrow && <div ref={panelSlot} className="scroll-mt-24" />}
          {!narrow && issuesPanel}

          <ReviewHistory doc={doc} />
        </div>
      </div>
      {createPortal(<AnimatePresence mode="wait">{sourcePanel}</AnimatePresence>, panelHost)}
    </div>
  );
}
