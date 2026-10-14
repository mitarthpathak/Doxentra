import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CrossDocumentIssue } from '../types';

export function ConflictComparison({ issue, onClose, onOpenDocument }: { issue: CrossDocumentIssue; onClose: () => void; onOpenDocument?: (id: string, key: string | null) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button') || [])];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return createPortal(<div className="fixed inset-0 z-[100] bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="conflict-title" className="bg-white rounded-3xl p-6 w-full max-w-3xl max-h-[85vh] overflow-auto shadow-2xl" onClick={e => e.stopPropagation()} data-testid="conflict-comparison">
      <div className="flex justify-between gap-4"><h2 id="conflict-title" className="font-bold text-xl">Compare conflicting values</h2><button type="button" onClick={onClose} aria-label="Close comparison">✕</button></div>
      <p className="text-sm text-slate-600 mt-3 mb-5">{issue.message}</p>
      <div className="grid sm:grid-cols-2 gap-4">{issue.refs.map((ref, index) => <section key={`${ref.documentId}:${index}`} className="rounded-2xl border border-red-200 bg-red-50 p-4 min-w-0">
        <p className="text-xs font-bold text-slate-500 uppercase">Source {index + 1} · {ref.docType.replace(/_/g, ' ')}</p>
        <h3 className="font-bold mt-2 break-words">{ref.title || ref.filename}</h3><p className="text-xs text-slate-500 break-all">{ref.filename}</p>
        <p className="mt-4 text-xs text-slate-500">{ref.fieldKey?.replace(/_/g, ' ') || 'Document'}</p><mark className="block mt-1 rounded-lg bg-red-100 p-3 font-semibold text-red-800 break-words" data-testid="conflicting-value">{ref.value ?? 'Not available'}</mark>
        {onOpenDocument && <button className="mt-4 text-xs font-bold text-primary underline" onClick={() => { onClose(); onOpenDocument(ref.documentId, ref.fieldKey); }}>Open source document</button>}
      </section>)}</div>
      <p className="text-xs text-slate-500 mt-4">A mismatch needs review; it does not establish which document is correct.</p>
    </div>
  </div>, document.body);
}

export function IntegrityCard({ issues, onOpenDocument, onGraph }: { issues: CrossDocumentIssue[]; onOpenDocument?: (id: string, key: string | null) => void; onGraph?: () => void }) {
  const [selected, setSelected] = useState<CrossDocumentIssue | null>(null);
  return <section className={`rounded-2xl border p-5 ${issues.length ? 'border-red-200 bg-red-50/70' : 'border-teal-200 bg-teal-50/50'}`} data-testid="integrity-card">
    <div className="flex items-start justify-between gap-3"><div><h3 className="font-bold">Cross-Document Integrity &amp; Mismatches</h3><p className="text-xs text-slate-600 mt-1">Compare linked identities, dates of birth and identifiers across your documents.</p></div><span className="rounded-full bg-white px-3 py-1 text-xs font-bold whitespace-nowrap" data-testid="conflict-badge">{issues.length} flagged</span></div>
    {issues.length ? <div className="mt-3 space-y-2">{issues.map((issue, i) => <button key={i} type="button" onClick={() => setSelected(issue)} className="flex items-center gap-3 w-full text-left rounded-xl border border-red-100 bg-white px-3 py-2 text-sm hover:border-red-300" data-testid="conflict-item"><span className="rounded-full bg-red-600 text-white w-6 h-6 shrink-0 text-center leading-6 motion-safe:animate-pulse shadow-[0_0_12px_#ef444480]">!</span><span>{issue.message}</span></button>)}</div> : <p className="text-xs text-slate-600 mt-3">No mismatches are shown for the current linked documents. Upload related documents to compare them.</p>}
    {onGraph && <button className="text-xs font-bold text-primary mt-3 underline" onClick={onGraph}>Explore the cross-document entity graph</button>}
    {selected && <ConflictComparison issue={selected} onClose={() => setSelected(null)} onOpenDocument={onOpenDocument} />}
  </section>;
}
