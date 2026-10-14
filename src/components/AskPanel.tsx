import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import type { AskCitation, AskTurn, DocumentSummary } from '../types';

const inputClass = 'w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-on-surface placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';
const selectClass = 'w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';

const SUGGESTIONS = [
  'What is the total amount on the invoice?',
  'Who is the certificate issued to, and when?',
  'Which documents have errors or missing fields?',
  'Summarise these documents in three points.',
];

type AskResponse = {
  answer: string;
  answerable: boolean;
  citations: AskCitation[];
  followUps: string[];
  mode: 'ai' | 'extractive' | 'none';
  notice?: string;
};

/** The answer with its [n] markers as buttons that jump to the citation. */
function AnswerText({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return (
    <p className="text-sm text-on-surface leading-relaxed whitespace-pre-line break-words" data-testid="ask-answer">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+(?:,\s*\d+)*)\]$/);
        if (!m) return <span key={i}>{part}</span>;
        return m[1].split(/,\s*/).map(n => (
          <button
            key={`${i}-${n}`}
            onClick={() => onCite(Number(n))}
            className="relative inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 mx-0.5 align-text-top rounded-full bg-primary/10 text-primary text-[9px] font-black hover:bg-primary hover:text-white transition-colors max-lg:after:absolute max-lg:after:-inset-x-1 max-lg:after:-inset-y-2.5"
            aria-label={`Source ${n}`}
          >
            {n}
          </button>
        ));
      })}
    </p>
  );
}

function CitationCard({ c, onOpen, highlighted }: { c: AskCitation; onOpen: () => void; highlighted: boolean }) {
  return (
    <button
      id={`citation-${c.n}`}
      onClick={onOpen}
      className={cn(
        'w-full text-left bg-surface-container-low rounded-2xl border p-3 md:p-4 hover:shadow-sm transition-all group',
        highlighted ? 'border-primary/40 ring-2 ring-primary/20' : 'border-slate-200 dark:border-slate-700'
      )}
      aria-label={`Open source ${c.n}: ${c.title}${c.page ? `, page ${c.page}` : ''}`}
      data-testid="ask-citation"
    >
      <div className="flex flex-wrap justify-between items-start gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-white text-[9px] font-black shrink-0">{c.n}</span>
          <p className="text-[11px] font-bold text-primary max-md:line-clamp-2 max-md:break-words md:truncate">{c.title}</p>
          <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded-full text-[9px] font-black text-slate-500 uppercase tracking-widest border border-slate-200 dark:border-slate-700 shrink-0">{c.docTypeLabel}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {c.page && <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">p.{c.page}</span>}
          {c.kind === 'profile' ? (
            <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border whitespace-nowrap bg-slate-100 dark:bg-slate-700 text-slate-500 border-slate-200 dark:border-slate-700" title="From the document's AI summary">
              From summary
            </span>
          ) : (
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border whitespace-nowrap',
                c.verified ? 'bg-tertiary/10 text-tertiary border-tertiary/20' : 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-300 border-amber-100 dark:border-amber-900/60'
              )}
              title={c.verified ? 'The quote was found word for word in the document' : 'The quote could not be found word for word in the document'}
            >
              {c.verified ? 'Verified quote' : 'Unverified'}
            </span>
          )}
        </div>
      </div>
      <blockquote className="border-l-4 border-primary bg-white dark:bg-slate-800 rounded-r-xl px-3 py-2 text-xs text-on-surface leading-relaxed break-words">
        {c.quote}
      </blockquote>
      <div className="flex justify-between items-center gap-2 md:gap-0 mt-2">
        <span className="text-[10px] text-on-surface-variant min-w-0 max-md:break-words md:truncate">{c.filename}{c.kind === 'issue' ? ' · validation check' : c.kind === 'field' ? ' · extracted field' : ''}</span>
        <span className="material-symbols-outlined shrink-0 text-slate-300 group-hover:text-primary group-hover:translate-x-1 transition-all text-lg">arrow_forward</span>
      </div>
    </button>
  );
}

interface AskPanelProps {
  turns: AskTurn[];
  setTurns: React.Dispatch<React.SetStateAction<AskTurn[]>>;
  scopeId: string;
  setScopeId: (id: string) => void;
  onOpenCitation: (c: AskCitation) => Promise<void>;
}

export function AskPanel({ turns, setTurns, scopeId, setScopeId, onOpenCitation }: AskPanelProps) {
  const [question, setQuestion] = useState('');
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ turn: string; n: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastQuestionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<{ documents: DocumentSummary[] }>('/documents').then(d => setDocs(d.documents)).catch(() => setDocs([]));
  }, []);

  const lastQuestionId = [...turns].reverse().find(t => t.role === 'user')?.id;
  const answering = !!turns[turns.length - 1]?.pending;
  const shownTurns = useRef(0);

  useEffect(() => {
    const added = turns.length !== shownTurns.current;
    shownTurns.current = turns.length;
    if (!turns.length) return;
    // Below lg the bottom nav covers the end of the page: bring the latest question to the top,
    // again once its answer has made the page long enough to scroll that far.
    if (window.matchMedia('(max-width: 1023px)').matches && lastQuestionRef.current) {
      lastQuestionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (added) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [turns.length, answering]);

  const scopeLabel = scopeId ? docs.find(d => d.id === scopeId)?.title || 'This document' : 'All documents';

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion('');
    setBusy(true);
    const history = turns.filter(t => !t.pending && !t.error).slice(-6).map(t => ({ role: t.role, content: t.content }));
    const userTurn: AskTurn = { id: `u${Date.now()}`, role: 'user', content: q, scopeLabel };
    const pendingId = `a${Date.now()}`;
    setTurns(prev => [...prev, userTurn, { id: pendingId, role: 'assistant', content: '', pending: true }]);
    try {
      const res = await apiFetch<AskResponse>('/ask', { method: 'POST', body: JSON.stringify({ question: q, documentId: scopeId || undefined, history }) });
      setTurns(prev => prev.map(t => (t.id === pendingId
        ? { id: pendingId, role: 'assistant', content: res.answer, citations: res.citations, followUps: res.followUps, mode: res.mode, notice: res.notice }
        : t)));
    } catch (err: any) {
      setTurns(prev => prev.map(t => (t.id === pendingId ? { id: pendingId, role: 'assistant', content: err?.message || 'Something went wrong. Please try again.', error: true } : t)));
    } finally {
      setBusy(false);
    }
  };

  const cite = (turn: AskTurn, n: number) => {
    setHighlight({ turn: turn.id, n });
    document.getElementById(`${turn.id}-citation-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const open = async (c: AskCitation) => {
    setOpenError(null);
    try {
      await onOpenCitation(c);
    } catch (err: any) {
      setOpenError(err?.message || 'Could not open the document.');
    }
  };

  return (
    <div className="space-y-8" data-testid="ask-panel">
      <form
        onSubmit={e => { e.preventDefault(); send(question); }}
        className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 dark:border-slate-700 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-4 items-end"
      >
        <div className="md:col-span-7">
          <label htmlFor="ask-q" className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Question</label>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">forum</span>
            <input
              id="ask-q"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="e.g. What is the due date? · कुल राशि कितनी है?"
              autoComplete="off"
              maxLength={1000}
              className={inputClass}
              data-testid="ask-input"
            />
          </div>
        </div>
        <div className="md:col-span-3">
          <label htmlFor="ask-scope" className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Ask about</label>
          <select id="ask-scope" value={scopeId} onChange={e => setScopeId(e.target.value)} className={selectClass} data-testid="ask-scope">
            <option value="">All documents</option>
            {docs.map(d => <option key={d.id} value={d.id}>{d.title || d.filename}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
            data-testid="ask-send"
          >
            <span className="material-symbols-outlined text-lg">{busy ? 'hourglass_top' : 'send'}</span>
            Ask
          </button>
        </div>
      </form>

      {openError && <p role="alert" className="text-red-500 dark:text-red-300 text-sm font-medium px-4 py-2 bg-red-50 dark:bg-red-950/40 rounded-lg border border-red-100 dark:border-red-900/60">{openError}</p>}

      {turns.length === 0 ? (
        <div className="text-center py-16 px-6 bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">forum</span>
          <p className="text-slate-500 font-medium mb-6">Ask anything about your documents. Every answer cites the document and page it came from.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => send(s)} className="px-3 py-2.5 lg:py-1.5 bg-primary/10 rounded-full text-xs text-primary font-medium hover:bg-primary/20 transition-colors">
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-6" aria-live="polite" data-testid="ask-conversation">
          <div className="flex justify-end">
            <button onClick={() => setTurns([])} className="relative text-[10px] font-bold text-primary uppercase tracking-widest hover:underline max-lg:after:absolute max-lg:after:-inset-x-2 max-lg:after:-inset-y-3">Clear conversation</button>
          </div>
          <AnimatePresence initial={false}>
            {turns.map(turn => (
              <motion.div key={turn.id} ref={turn.id === lastQuestionId ? lastQuestionRef : undefined} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={cn('flex scroll-mt-20', turn.role === 'user' ? 'justify-end' : 'justify-start')}>
                {turn.role === 'user' ? (
                  <div className="max-w-[85%] md:max-w-[70%]">
                    <div className="bg-primary text-white rounded-3xl rounded-br-lg px-5 py-3 text-sm font-medium break-words">{turn.content}</div>
                    {turn.scopeLabel && <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1 text-right truncate">{turn.scopeLabel}</p>}
                  </div>
                ) : turn.pending ? (
                  <div className="bg-white dark:bg-slate-800 rounded-3xl p-4 md:p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex items-center gap-3 text-sm text-on-surface-variant">
                    <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
                    Reading your documents…
                  </div>
                ) : (
                  <div className={cn('w-full md:max-w-[90%] rounded-3xl p-4 md:p-6 border shadow-sm space-y-4', turn.error ? 'bg-red-50 dark:bg-red-950/40 border-red-100 dark:border-red-900/60 text-red-700 dark:text-red-200' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700')} data-testid="ask-turn">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary text-lg">{turn.error ? 'error' : 'auto_awesome'}</span>
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-60">
                        {turn.error ? 'Could not answer' : turn.mode === 'extractive' ? 'Best matching passages' : 'Answer'}
                      </p>
                    </div>
                    {turn.notice && (
                      <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/60 rounded-2xl text-xs text-amber-700 dark:text-amber-300">{turn.notice}</div>
                    )}
                    {turn.error ? (
                      <p className="text-sm text-red-500 dark:text-red-300 font-medium">{turn.content}</p>
                    ) : (
                      <AnswerText text={turn.content} onCite={n => cite(turn, n)} />
                    )}
                    {!!turn.citations?.length && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          Sources · {turn.citations.filter(c => c.verified).length} of {turn.citations.filter(c => c.kind !== 'profile').length} quotes verified
                        </p>
                        {turn.citations.map(c => (
                          <div key={c.n} id={`${turn.id}-citation-${c.n}`} className="scroll-mt-24 max-lg:scroll-mb-28">
                            <CitationCard c={c} onOpen={() => open(c)} highlighted={highlight?.turn === turn.id && highlight.n === c.n} />
                          </div>
                        ))}
                      </div>
                    )}
                    {!!turn.followUps?.length && (
                      <div className="flex flex-wrap gap-2">
                        {turn.followUps.map(f => (
                          <button key={f} onClick={() => send(f)} disabled={busy} className="px-3 py-2.5 lg:py-1.5 bg-primary/10 rounded-full text-xs text-primary font-medium hover:bg-primary/20 transition-colors disabled:opacity-50">
                            {f}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
