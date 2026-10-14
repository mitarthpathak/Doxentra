import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { DocumentSummary } from '../types';

type Rule = { id: string; label: string; kind: string; docType: string; source: { page: number; line: number; quote: string } };
type Policy = { requirements: Rule[]; method: string; builtAt: string };
type PacketListItem = { id: string; title: string; documentIds: string[]; policyId: string | null };
type Task = { kind: string; status: string; priority: number; message: string; ruleSource?: { documentId: string; page: number; line: number; quote: string }; evidence?: { documentId: string; fieldKey?: string | null; page?: number | null; quote?: string | null }; refs?: { documentId: string; fieldKey: string | null; title: string }[] };
type PacketDetail = PacketListItem & { documents: { id: string; filename: string; docType: string }[]; policy: { id: string; filename: string; requirements: Rule[] } | null; checklist: { rule: Rule; status: string; message: string; evidence?: Task['evidence'] }[]; tasks: Task[]; counts: { urgent: number; attention: number; verify: number }; changes: { documentId: string; twin: { changes: { label: string; before: { value: string }; after: { value: string } }[] } }[] };

const card = 'bg-surface-container-low rounded-[28px] border border-slate-200 dark:border-slate-700 p-5 md:p-7 shadow-sm';

export function PacketScreen({ onOpenDocument }: { onOpenDocument: (id: string, fieldKey?: string | null, quote?: string | null, page?: number | null) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [packets, setPackets] = useState<PacketListItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [detail, setDetail] = useState<PacketDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [d, p] = await Promise.all([
      apiFetch<{ documents: DocumentSummary[] }>('/documents'),
      apiFetch<{ packets: PacketListItem[] }>('/packets'),
    ]);
    setDocs(d.documents);
    setPackets(p.packets);
  }, []);
  useEffect(() => {
    reload().then(async () => {
      const id = sessionStorage.getItem('doxentra_open_packet');
      if (!id) return;
      const r = await apiFetch<{ packet: PacketDetail }>(`/packets/${encodeURIComponent(id)}`);
      setDetail(r.packet); setTitle(r.packet.title); setSelected(r.packet.documentIds); setPolicyId(r.packet.policyId || '');
    }).catch((e: Error) => setError(e.message));
  }, [reload]);
  useEffect(() => {
    if (!policyId) { setPolicy(null); return; }
    apiFetch<{ policy: Policy | null }>(`/policies/${encodeURIComponent(policyId)}`)
      .then(r => setPolicy(r.policy)).catch(() => setPolicy(null));
  }, [policyId]);
  const refreshDetail = useCallback(async (id: string) => {
    const r = await apiFetch<{ packet: PacketDetail }>(`/packets/${encodeURIComponent(id)}`);
    setDetail(r.packet);
  }, []);
  const build = async () => {
    if (!policyId) return;
    setBusy(true); setError(null);
    try { const r = await apiFetch<{ policy: Policy }>(`/policies/${encodeURIComponent(policyId)}/build`, { method: 'POST' }); setPolicy(r.policy); }
    catch (e: any) { setError(e?.message || 'Could not build the checklist.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { title, documentIds: selected, policyId: policyId || null };
      const id = detail?.id;
      const r = await apiFetch<{ packet: PacketListItem }>(id ? `/packets/${encodeURIComponent(id)}` : '/packets', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      await reload(); await refreshDetail(r.packet.id);
      sessionStorage.setItem('doxentra_open_packet', r.packet.id);
    } catch (e: any) { setError(e?.message || 'Could not save the packet.'); }
    finally { setBusy(false); }
  };
  const openPacket = async (packet: PacketListItem) => {
    setTitle(packet.title); setSelected(packet.documentIds); setPolicyId(packet.policyId || ''); setError(null);
    sessionStorage.setItem('doxentra_open_packet', packet.id);
    try { await refreshDetail(packet.id); } catch (e: any) { setError(e.message); }
  };
  const openEvidence = (e?: Task['evidence']) => { if (e?.documentId) onOpenDocument(e.documentId, e.fieldKey, e.quote, e.page); };
  return <main className="max-w-6xl mx-auto px-4 py-8 space-y-6" data-testid="packet-screen">
    <header><p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Institutional workflow</p><h2 className="text-3xl md:text-4xl font-headline font-bold">Packet review cockpit</h2><p className="text-sm text-on-surface-variant mt-2">Group uploaded documents, build a checklist from a circular, and review the highest priority findings.</p></header>
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-950/40 p-3 rounded-xl">{error}</p>}
    <div className="grid lg:grid-cols-3 gap-5">
      <section className={`${card} space-y-4 lg:col-span-1`}>
        <div className="flex justify-between items-center"><h3 className="text-lg font-bold">Cases</h3><button className="text-xs font-bold text-primary" onClick={() => { sessionStorage.removeItem('doxentra_open_packet'); setDetail(null); setTitle(''); setSelected([]); setPolicyId(''); }}>New case</button></div>
        {packets.map(p => <button key={p.id} onClick={() => openPacket(p)} className={`w-full text-left p-3 rounded-xl border text-sm ${detail?.id === p.id ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'}`}><strong className="block">{p.title}</strong><span className="text-xs text-on-surface-variant">{p.documentIds.length} documents</span></button>)}
        {!packets.length && <p className="text-xs text-on-surface-variant">Create a case from the documents you have uploaded.</p>}
      </section>
      <section className={`${card} space-y-4 lg:col-span-2`}>
        <h3 className="text-lg font-bold">{detail ? 'Edit case' : 'Create case'}</h3>
        <label className="block text-xs font-bold">Case title<input className="block w-full mt-1 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Asha · Scholarship 2026" maxLength={120} /></label>
        <div><p className="text-xs font-bold mb-2">Student packet</p><div className="max-h-52 overflow-y-auto space-y-1">{docs.filter(d => d.id !== policyId).map(d => <label key={d.id} className="flex gap-2 items-start p-2 bg-white dark:bg-slate-800 rounded-lg text-xs"><input type="checkbox" checked={selected.includes(d.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, d.id] : ids.filter(id => id !== d.id))} /><span>{d.filename} · {d.docTypeLabel}</span></label>)}</div></div>
        <label className="block text-xs font-bold">Institution circular or rule<select value={policyId} onChange={e => { setPolicyId(e.target.value); setPolicy(null); setSelected(ids => ids.filter(id => id !== e.target.value)); }} className="block w-full mt-1 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"><option value="">No circular selected</option>{docs.map(d => <option key={d.id} value={d.id}>{d.filename}</option>)}</select></label>
        {policyId && <div className="space-y-2"><button disabled={busy} onClick={build} className="px-4 py-2 bg-primary/10 text-primary rounded-full text-xs font-bold disabled:opacity-50">{policy ? 'Rebuild checklist' : 'Build checklist from circular'}</button>{policy && <p className="text-xs text-on-surface-variant">{policy.requirements.length} source verified requirements · {policy.method === 'ai' ? 'AI draft' : 'text rules'}. Check the cited lines before relying on it.</p>}</div>}
        {policy?.requirements.map(rule => <div key={rule.id} className="p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs"><strong>{rule.label}</strong><p className="mt-1 text-on-surface-variant">Page {rule.source.page}, line {rule.source.line}: “{rule.source.quote}”</p><button className="text-primary font-bold mt-1" onClick={() => onOpenDocument(policyId, null, rule.source.quote, rule.source.page)}>Open circular source</button></div>)}
        <button disabled={busy || !title.trim() || !selected.length || Boolean(policyId && !policy)} onClick={save} className="px-5 py-2.5 rounded-full bg-primary text-white text-xs font-bold disabled:opacity-50">{detail ? 'Update case' : 'Create case'}</button>
      </section>
    </div>
    {detail && <div className="space-y-5">
      <section className={card}><h3 className="text-xl font-bold">{detail.title}</h3><p className="text-sm text-on-surface-variant mt-1">{detail.documents.length} documents · {detail.counts.urgent} urgent · {detail.counts.attention} attention · {detail.counts.verify} verify</p><button className="text-xs font-bold text-primary mt-3" onClick={() => refreshDetail(detail.id)}>Refresh after corrections</button></section>
      {detail.policy && <section className={`${card} space-y-3`}><h3 className="text-lg font-bold">Policy checklist</h3>{detail.checklist.map(item => <div key={item.rule.id} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-sm"><strong>{item.status.toUpperCase()} · {item.rule.label}</strong><p>{item.message}</p><p className="text-xs text-on-surface-variant mt-1">Rule: page {item.rule.source.page}, line {item.rule.source.line} · “{item.rule.source.quote}”</p><div className="flex gap-3 mt-2"><button className="text-xs font-bold text-primary" onClick={() => onOpenDocument(detail.policy!.id, null, item.rule.source.quote, item.rule.source.page)}>Open rule</button>{item.evidence && <button className="text-xs font-bold text-primary" onClick={() => openEvidence(item.evidence)}>Open proof</button>}</div></div>)}</section>}
      <section className={`${card} space-y-3`}><h3 className="text-lg font-bold">Priority review · {detail.tasks.length}</h3>{!detail.tasks.length && <p className="text-sm text-tertiary">No open findings in this packet.</p>}{detail.tasks.map((task, i) => <div key={i} className={`p-3 rounded-xl border text-sm ${task.priority === 0 ? 'bg-red-50 dark:bg-red-950/40 border-red-100 dark:border-red-900/60' : task.priority === 1 ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-100 dark:border-amber-900/60' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'}`}><strong className="uppercase text-[10px]">{task.kind} · {task.status}</strong><p>{task.message}</p>{task.ruleSource && <p className="text-xs text-on-surface-variant mt-1">Rule · page {task.ruleSource.page}, line {task.ruleSource.line}: “{task.ruleSource.quote}”</p>}<div className="flex gap-3 flex-wrap mt-2">{task.ruleSource && <button className="text-xs font-bold text-primary" onClick={() => onOpenDocument(task.ruleSource!.documentId, null, task.ruleSource!.quote, task.ruleSource!.page)}>Open rule source</button>}{task.evidence && <button className="text-xs font-bold text-primary" onClick={() => openEvidence(task.evidence)}>Open evidence / correct</button>}{task.refs?.map((ref, j) => <button key={j} className="text-xs font-bold text-primary" onClick={() => onOpenDocument(ref.documentId, ref.fieldKey)}>Open {ref.title}</button>)}</div></div>)}</section>
      {detail.changes.length > 0 && <section className={`${card} space-y-2`}><h3 className="text-lg font-bold">What changed in this packet?</h3>{detail.changes.map(({ documentId, twin }) => <div key={documentId} className="bg-white dark:bg-slate-800 p-3 border border-slate-200 dark:border-slate-700 rounded-xl text-sm">{twin.changes.map((change, i) => <p key={i}>{change.label}: {change.before.value ?? 'empty'} → {change.after.value ?? 'empty'}</p>)}<button className="text-xs font-bold text-primary mt-2" onClick={() => onOpenDocument(documentId)}>Open both source pages</button></div>)}</section>}
    </div>}
  </main>;
}
