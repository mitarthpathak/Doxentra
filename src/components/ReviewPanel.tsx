import { useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { apiFetch, percent } from '../lib/api';
import type { AuditEntry, DocumentResult, ExtractedField } from '../types';

const send = (doc: DocumentResult, path: string, method: 'PATCH' | 'POST', body: object) =>
  apiFetch<DocumentResult>(`/documents/${encodeURIComponent(doc.id)}${path}`, { method, body: JSON.stringify(body) });

const pill = 'flex items-center gap-2 px-3 py-2 lg:py-1.5 rounded-full text-[10px] font-bold uppercase transition-colors disabled:opacity-50';

/** Confirm, correct or reset the selected field (shown in the source panel). */
export function FieldReview({ doc, field, onChange }: { doc: DocumentResult; field: ExtractedField; onChange: (doc: DocumentResult) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.value ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setValue(field.value ?? '');
    setNote('');
    setError(null);
  }, [doc.id, field.key, field.value]);

  const act = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await send(doc, `/fields/${encodeURIComponent(field.key)}`, 'PATCH', body));
      setEditing(false);
    } catch (err: any) {
      setError(err?.message || 'Could not save the review. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-100 pt-4" data-testid="field-review">
      <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Human review</p>
      {field.review && (
        <p className="text-xs text-on-surface-variant break-words" data-testid="field-review-status">
          <span className="font-bold text-tertiary">{field.review.status === 'confirmed' ? 'Confirmed' : 'Corrected'}</span> by {field.review.by} · {new Date(field.review.at).toLocaleString()}
          {field.review.status === 'corrected' && <> · AI read <span className="font-mono">{field.review.original.value ?? 'nothing'}</span></>}
        </p>
      )}
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={e => {
            e.preventDefault();
            act({ action: 'correct', value: value.trim() ? value : null, note: note || undefined });
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            aria-label={`Correct value of ${field.label}`}
            placeholder="Leave empty if it is not in the document"
            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-base lg:text-sm text-on-surface placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
            data-testid="review-value"
          />
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            aria-label="Note (optional)"
            placeholder="Note (optional)"
            maxLength={300}
            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-base lg:text-sm text-on-surface placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={cn(pill, 'bg-primary text-white hover:opacity-90')} data-testid="review-save">
              <span className="material-symbols-outlined text-sm">save</span>
              {busy ? 'Saving…' : 'Save correction'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={cn(pill, 'bg-slate-100 text-slate-500 hover:bg-slate-200')}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {field.value != null && field.review?.status !== 'confirmed' && (
            <button type="button" disabled={busy} onClick={() => act({ action: 'confirm' })} className={cn(pill, 'bg-tertiary/10 text-tertiary hover:bg-tertiary/20')} data-testid="review-confirm">
              <span className="material-symbols-outlined text-sm">check_circle</span>
              Confirm
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className={cn(pill, 'bg-primary/10 text-primary hover:bg-primary/20')} data-testid="review-correct">
            <span className="material-symbols-outlined text-sm">edit</span>
            {field.value == null ? 'Add value' : 'Correct'}
          </button>
          {field.review && (
            <button type="button" disabled={busy} onClick={() => act({ action: 'reset' })} className={cn(pill, 'bg-slate-100 text-slate-500 hover:bg-slate-200')} data-testid="review-reset">
              <span className="material-symbols-outlined text-sm">undo</span>
              Back to AI value
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-red-500 text-xs font-medium">{error}</p>}
    </div>
  );
}

/** Approve or reopen the document (an action pill in the header). */
export function ApproveButton({ doc, onChange, onError }: { doc: DocumentResult; onChange: (doc: DocumentResult) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const approved = doc.review?.status === 'approved';
  const errors = doc.issueCounts?.error ?? doc.issues.filter(i => i.severity === 'error').length;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!approved && errors > 0 && !window.confirm(`This document still has ${errors} error${errors === 1 ? '' : 's'}. Approve it anyway?`)) return;
        setBusy(true);
        try {
          onChange(await send(doc, '/review', 'POST', { action: approved ? 'reopen' : 'approve' }));
        } catch (err: any) {
          onError(err?.message || 'Could not save the review. Please try again.');
        } finally {
          setBusy(false);
        }
      }}
      className={cn(pill, 'bg-tertiary/10 text-tertiary hover:bg-tertiary/20')}
      data-testid="review-approve"
    >
      <span className="material-symbols-outlined text-sm">{approved ? 'lock_open' : 'verified'}</span>
      {busy ? 'Saving…' : approved ? 'Reopen review' : 'Approve document'}
    </button>
  );
}

const ACTION_TEXT: Record<AuditEntry['action'], { icon: string; verb: string }> = {
  confirm: { icon: 'check_circle', verb: 'Confirmed' },
  correct: { icon: 'edit', verb: 'Corrected' },
  reset: { icon: 'undo', verb: 'Reset to the AI value' },
  approve: { icon: 'verified', verb: 'Approved the document' },
  reopen: { icon: 'lock_open', verb: 'Reopened the review' },
  twin_approve: { icon: 'verified', verb: 'Approved the document changes' },
  twin_needs_review: { icon: 'flag', verb: 'Marked the document changes for review' },
};

/** The append-only review trail, newest first. */
export function ReviewHistory({ doc }: { doc: DocumentResult }) {
  const entries = [...(doc.audit || [])].reverse();
  if (!entries.length) return null;
  return (
    <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-5" data-testid="review-history">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Audit trail</p>
        <p className="text-xl font-headline font-bold mt-1">Review history · {doc.auditCount ?? entries.length}</p>
      </div>
      <ul className="space-y-3">
        {entries.map((e, i) => {
          const t = ACTION_TEXT[e.action];
          const errorsDelta = e.issuesAfter.error - e.issuesBefore.error;
          return (
            <li key={`${e.at}-${i}`} className="flex gap-3 px-4 py-3 bg-white rounded-2xl border border-slate-200" data-testid="audit-entry">
              <span className="material-symbols-outlined text-[18px] text-primary shrink-0">{t.icon}</span>
              <div className="min-w-0 text-sm space-y-1">
                <p className="font-medium break-words">
                  {t.verb}{e.label ? ` ${e.label}` : ''}
                  {e.action === 'correct' && (
                    <>: <span className="font-mono text-xs line-through text-slate-400">{e.from ?? 'empty'}</span> → <span className="font-mono text-xs">{e.to ?? 'empty'}</span></>
                  )}
                </p>
                {e.note && <p className="text-xs text-on-surface-variant italic break-words">“{e.note}”</p>}
                <p className="text-[10px] text-on-surface-variant break-words">
                  {e.by} · {new Date(e.at).toLocaleString()}
                  {errorsDelta !== 0 && <span className={errorsDelta > 0 ? 'text-red-500' : 'text-tertiary'}> · {errorsDelta > 0 ? '+' : ''}{errorsDelta} error{Math.abs(errorsDelta) === 1 ? '' : 's'}</span>}
                  {e.overallBefore != null && e.overallAfter != null && e.overallBefore !== e.overallAfter && <> · confidence {percent(e.overallBefore)} → {percent(e.overallAfter)}</>}
                  {e.approvalWithdrawn && <span className="text-amber-600"> · approval withdrawn</span>}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
