import { useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { apiFetch, confidenceBand, percent } from '../lib/api';
import type { AuditEntry, CrossDocumentIssue, DocumentResult } from '../types';

const SEVERITY = {
  error: { icon: 'error', text: 'text-red-500', box: 'bg-red-50 border-red-100' },
  warning: { icon: 'warning', text: 'text-amber-600', box: 'bg-amber-50 border-amber-100' },
  info: { icon: 'info', text: 'text-primary', box: 'bg-primary/5 border-primary/10' },
} as const;

const VERB: Record<AuditEntry['action'], string> = {
  confirm: 'Confirmed', correct: 'Corrected', reset: 'Reset', approve: 'Approved the document', reopen: 'Reopened the review',
  twin_approve: 'Approved the document changes', twin_needs_review: 'Marked the document changes for review',
};

/**
 * Validation and review summary of the document a concept map was built
 * from (shown on top of the Details page). Renders nothing for a map that
 * is not tied to an extracted document.
 */
export function DocumentCheckSummary({ documentId, masked = false, onOpenDocument }: { documentId?: string; masked?: boolean; onOpenDocument: (id: string) => void }) {
  const [doc, setDoc] = useState<DocumentResult | null>(null);
  const [cross, setCross] = useState<CrossDocumentIssue[]>([]);

  useEffect(() => {
    setDoc(null);
    setCross([]);
    if (!documentId) return;
    let cancelled = false;
    const q = masked ? '?redact=1' : '';
    apiFetch<DocumentResult>(`/documents/${encodeURIComponent(documentId)}${q}`)
      .then(d => !cancelled && setDoc(d))
      .catch(() => { /* a concept map uploaded on its own: nothing to summarise */ });
    apiFetch<{ issues: CrossDocumentIssue[] }>(`/crosscheck?documentId=${encodeURIComponent(documentId)}${masked ? '&redact=1' : ''}`)
      .then(r => !cancelled && setCross(r.issues))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [documentId, masked]);

  if (!doc) return null;
  const counts = { error: 0, warning: 0, info: 0, ...(doc.issueCounts || {}) };
  for (const i of cross) counts[i.severity]++;
  const top = [...doc.issues.filter(i => i.severity !== 'info'), ...cross]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : b.severity === 'error' ? 1 : 0))
    .slice(0, 3);
  const review = doc.review;
  const recent = [...(doc.audit || [])].reverse().slice(0, 3);
  const band = confidenceBand(doc.overallConfidence);

  return (
    <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 dark:border-slate-700 shadow-sm space-y-6" data-testid="document-check-summary">
      <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Document check</p>
          <p className="text-xl font-headline font-bold mt-1 break-words">{doc.title || doc.filename}</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="px-4 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase rounded-full border border-primary/20 tracking-widest">
              {doc.docTypeLabel} · {percent(doc.docTypeConfidence)}
            </span>
            <span
              className={cn('px-4 py-1 text-[10px] font-black uppercase rounded-full border tracking-widest max-lg:max-w-full max-lg:wrap-anywhere',
                review?.status === 'approved' ? 'bg-tertiary/10 text-tertiary border-tertiary/20'
                  : review?.status === 'in_review' ? 'bg-amber-50 text-amber-600 border-amber-100'
                  : 'bg-slate-100 dark:bg-slate-700 text-slate-500 border-slate-200 dark:border-slate-700')}
              data-testid="summary-review-status"
            >
              {review?.status === 'approved' ? `Approved${review.approvedBy ? ` by ${review.approvedBy}` : ''}`
                : review?.status === 'in_review' ? `In review · ${review.reviewed}/${review.total}`
                : 'Not reviewed yet'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-center">
            <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Confidence</p>
            <p className={cn('text-3xl font-headline font-bold', band === 'high' ? 'text-tertiary' : band === 'medium' ? 'text-amber-600' : 'text-red-500')}>{percent(doc.overallConfidence)}</p>
          </div>
          <div className="flex gap-1" aria-label="Issues by severity" data-testid="summary-issue-counts">
            {(['error', 'warning', 'info'] as const).map(s => (
              <span key={s} className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase border', SEVERITY[s].box, SEVERITY[s].text)} title={`${counts[s]} ${s}`}>
                <span className="material-symbols-outlined text-[12px]">{SEVERITY[s].icon}</span>
                {counts[s]}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Validation</p>
          {top.length ? top.map((i, n) => (
            <p key={n} className={cn('flex gap-2 px-4 py-3 rounded-2xl border text-xs font-medium leading-relaxed', SEVERITY[i.severity].box)} data-testid="summary-issue">
              <span className={cn('material-symbols-outlined text-[16px] shrink-0', SEVERITY[i.severity].text)}>{SEVERITY[i.severity].icon}</span>
              <span className="break-words">{i.message}</span>
            </p>
          )) : (
            <p className="flex items-center gap-2 text-sm text-tertiary font-medium">
              <span className="material-symbols-outlined text-[18px]">check_circle</span>
              No errors or warnings.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Audit trail · {doc.auditCount ?? recent.length}</p>
          {recent.length ? recent.map((a, n) => (
            <p key={n} className="px-4 py-3 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 text-xs max-lg:break-words" data-testid="summary-audit">
              <span className="font-medium">{VERB[a.action]}{a.label ? ` ${a.label}` : ''}</span>
              <span className="block text-[10px] text-on-surface-variant mt-0.5">{a.by} · {new Date(a.at).toLocaleString()}</span>
            </p>
          )) : (
            <p className="text-sm text-on-surface-variant">No one has reviewed this document yet.</p>
          )}
        </div>
      </div>

      <button onClick={() => onOpenDocument(doc.id)} className="py-3 -my-3 lg:py-0 lg:my-0 text-[10px] font-bold text-primary uppercase tracking-widest hover:underline" data-testid="summary-open-document">
        Open the document to review it →
      </button>
    </div>
  );
}
