import { getProcessingMode, switchProcessingMode, useProcessingBusy } from '../lib/processingMode';
export function ProcessingModeToggle({ compact = false }: { compact?: boolean }) {
  const privacy = getProcessingMode() === 'privacy';
  const busy = useProcessingBusy();
  const description = privacy ? 'Local English OCR, field extraction and validation on this server. Document processing does not use cloud AI.' : 'Full multi-modal intelligence, knowledge graph, and AI reasoning.';
  return <div className={compact ? '' : 'rounded-2xl border border-slate-200 bg-white p-4 space-y-2'} data-testid="processing-mode">
    {!compact && <p className="text-xs font-bold text-slate-500">Processing Mode</p>}
    <button type="button" role="switch" aria-checked={privacy} aria-label="Air-Gapped / High-Privacy Mode" disabled={busy} onClick={switchProcessingMode} title={busy ? 'Finish the current upload before switching modes.' : description}
      className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold disabled:opacity-50 ${privacy ? 'bg-emerald-50 text-emerald-800' : 'bg-cyan-50 text-cyan-800'}`}>
      <span className={`relative w-8 h-5 shrink-0 rounded-full ${privacy ? 'bg-emerald-600' : 'bg-slate-300'}`}><span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${privacy ? 'translate-x-3' : 'translate-x-0'}`} /></span>
      {compact ? privacy ? 'Privacy' : 'Deep AI' : privacy ? 'Air-Gapped / High-Privacy Mode' : 'Deep Intelligence Mode'}
    </button>
    {!compact && <><p className="text-xs text-slate-600">{description}</p>{privacy && <p className="text-[11px] text-slate-500">PDFs, scans and photos · separate server-memory workspace · cleared on server restart. Privacy controls support DPDP/GDPR obligations; compliance depends on deployment and data handling.</p>}</>}
  </div>;
}
