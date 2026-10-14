import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { PagePreview } from './PagePreview';
import type { DocumentResult, DocumentTwin, TwinSource } from '../types';

function Evidence({ source, fieldKey }: { source: TwinSource; fieldKey: string }) {
  return <div className="min-w-0 space-y-2">
    <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant break-words">{source.filename} · page {source.page ?? '?'}</p>
    <p className="text-sm font-semibold break-all">{source.value ?? 'Not found'}</p>
    {source.sourceQuote && <blockquote className="text-xs text-on-surface-variant border-l-2 border-primary pl-2">{source.sourceQuote}</blockquote>}
    {source.hasFile && source.value && <PagePreview docId={source.documentId} page={source.page} quote={source.sourceQuote} value={source.value} fieldKey={fieldKey} box={source.box} />}
  </div>;
}

export function TwinPanel({ doc, onDocumentChange }: { doc: DocumentResult; onDocumentChange?: (doc: DocumentResult) => void }) {
  const [twin, setTwin] = useState<DocumentTwin | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setTwin(null);
    apiFetch<{ twin: DocumentTwin | null }>(`/documents/${encodeURIComponent(doc.id)}/twin`)
      .then(r => { if (live) setTwin(r.twin); })
      .catch(() => { if (live) setTwin(null); });
    return () => { live = false; };
  }, [doc.id, doc.auditCount]);
  if (!twin) return null;
  const decide = async (action: 'approve' | 'needs_review') => {
    setBusy(true); setError(null);
    try {
      const result = await apiFetch<{ twin: DocumentTwin; document: DocumentResult }>(`/documents/${encodeURIComponent(doc.id)}/twin/review`, {
        method: 'POST', body: JSON.stringify({ action, fingerprint: twin.fingerprint }),
      });
      setTwin(result.twin);
      onDocumentChange?.(result.document);
    } catch (err: any) { setError(err?.message || 'Could not save the decision.'); }
    finally { setBusy(false); }
  };
  return <section className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 dark:border-slate-700 shadow-sm space-y-4" data-testid="twin-panel">
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Document Twin + Change Radar</p>
      <h3 className="text-xl font-headline font-bold mt-1">{twin.changes.length} changed field{twin.changes.length === 1 ? '' : 's'}</h3>
      <p className="text-xs text-on-surface-variant mt-1">Compared with {twin.previousFilename} · {twin.matchReason}. Changes need human review; they do not prove fraud.</p>
    </div>
    {twin.changes.length ? <div className="space-y-2">{twin.changes.map(change => <div key={change.key} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-3">
      <button type="button" className="w-full text-left" onClick={() => setOpen(open === change.key ? null : change.key)} aria-expanded={open === change.key}>
        <span className="block text-[10px] uppercase font-bold text-on-surface-variant">{change.label}</span>
        <span className="block text-sm break-all"><span className="text-slate-500">{change.before.value ?? 'Not found'}</span> → <strong>{change.after.value ?? 'Not found'}</strong></span>
        <span className="text-[10px] text-primary font-bold">{open === change.key ? 'Hide original pages' : 'Open both original pages'}</span>
      </button>
      {open === change.key && <div className="grid md:grid-cols-2 gap-4 mt-4"><Evidence source={change.before} fieldKey={change.key} /><Evidence source={change.after} fieldKey={change.key} /></div>}
    </div>)}</div> : <p className="text-sm text-tertiary">No field changes found.</p>}
    {twin.conflicts.length > 0 && <p className="text-sm text-amber-700 font-medium">{twin.conflicts.length} related cross document check{twin.conflicts.length === 1 ? '' : 's'} in the earlier packet. See validation for sources.</p>}
    {twin.review && <p className="text-xs font-bold text-primary">{twin.review.status === 'approve' ? 'Approved' : 'Needs review'} by {twin.review.by} · {new Date(twin.review.at).toLocaleString()}</p>}
    {twin.changes.length > 0 && onDocumentChange && <div className="flex gap-2 flex-wrap">
      <button disabled={busy} onClick={() => decide('approve')} className="px-4 py-2 rounded-full bg-tertiary/10 text-tertiary text-xs font-bold disabled:opacity-50">Approve changes</button>
      <button disabled={busy} onClick={() => decide('needs_review')} className="px-4 py-2 rounded-full bg-amber-100 text-amber-800 text-xs font-bold disabled:opacity-50">Needs review</button>
    </div>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>;
}
