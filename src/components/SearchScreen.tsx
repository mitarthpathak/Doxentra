import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { apiFetch, DOC_TYPE_OPTIONS, percent } from '../lib/api';
import { ConfidenceChip } from './DocumentScreen';
import { AskPanel } from './AskPanel';
import { cn } from '../lib/utils';
import type { AskCitation, AskTurn, SearchHit, User } from '../types';

const DEBOUNCE_MS = 300;
const KIND_LABELS: Record<SearchHit['kind'], string> = {
  field: 'Field', entity: 'Entity', summary: 'Summary', issue: 'Validation', text: 'Page text', title: 'Title', document: 'Document',
};
const CONFIDENCE_OPTIONS = [
  { value: '', label: 'Any confidence' },
  { value: '0.5', label: 'Medium or higher (≥ 50%)' },
  { value: '0.8', label: 'High only (≥ 80%)' },
];
const inputClass = 'w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-on-surface placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';
const selectClass = 'w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  [...ranges].sort((a, b) => a[0] - b[0]).forEach(([a, b], i) => {
    if (a < pos) return;
    if (a > pos) parts.push(text.slice(pos, a));
    parts.push(<mark key={i} className="bg-primary/10 text-primary rounded px-0.5 font-bold">{text.slice(a, b)}</mark>);
    pos = b;
  });
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

export type SearchMode = 'search' | 'ask';

interface SearchScreenProps {
  user: User | null;
  onSignInClick: () => void;
  onOpenHit: (hit: SearchHit) => Promise<void>;
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  askTurns: AskTurn[];
  setAskTurns: React.Dispatch<React.SetStateAction<AskTurn[]>>;
  askScope: string;
  setAskScope: (id: string) => void;
  onOpenCitation: (c: AskCitation) => Promise<void>;
}

export function SearchScreen({ user, onSignInClick, onOpenHit, mode, onModeChange, askTurns, setAskTurns, askScope, setAskScope, onOpenCitation }: SearchScreenProps) {
  const [q, setQ] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const [type, setType] = useState('');
  const [minConfidence, setMinConfidence] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!q.trim() && !type && !minConfidence) {
      setResults(null);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: q.trim() });
      if (type) params.set('type', type);
      if (minConfidence) params.set('minConfidence', minConfidence);
      apiFetch<{ results: SearchHit[] }>(`/search?${params}`)
        .then(data => {
          if (id !== requestId.current) return;
          setResults(data.results);
          setError(null);
        })
        .catch(err => id === requestId.current && setError(err.message || 'Search failed.'))
        .finally(() => id === requestId.current && setLoading(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, type, minConfidence, user]);

  const open = async (hit: SearchHit, key: string) => {
    setOpening(key);
    try {
      await onOpenHit(hit);
    } catch (err: any) {
      setError(err.message || 'Could not open the document.');
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="space-y-10 py-8">
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
        <div className="max-w-xl">
          <h2 className="text-4xl md:text-5xl font-headline font-bold mb-4">{mode === 'ask' ? 'Ask Your Documents' : 'Search Documents'}</h2>
          <p className="text-on-surface-variant leading-relaxed">
            {mode === 'ask'
              ? 'Ask questions in English or Hindi. Answers come only from your documents, with the document and page of every fact.'
              : 'Search every field, entity, issue, summary and page of your extracted documents, in English or Hindi.'}
          </p>
        </div>
        <div className="flex gap-2 shrink-0" role="tablist" aria-label="Search or ask">
          {([['search', 'manage_search', 'Search'], ['ask', 'forum', 'Ask']] as const).map(([key, icon, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              onClick={() => onModeChange(key)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-full text-[10px] font-bold uppercase transition-colors',
                mode === key ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'
              )}
              data-testid={`mode-${key}`}
            >
              <span className="material-symbols-outlined text-sm">{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!user && (
        <p className="text-xs text-slate-500 -mt-6">
          Searching the documents uploaded in this browser. <button onClick={onSignInClick} className="relative text-primary font-bold hover:underline max-lg:after:absolute max-lg:after:-inset-x-1 max-lg:after:-inset-y-2.5">Sign in</button> to keep them in your account.
        </p>
      )}
      {mode === 'ask' ? (
        <AskPanel turns={askTurns} setTurns={setAskTurns} scopeId={askScope} setScopeId={setAskScope} onOpenCitation={onOpenCitation} />
      ) : (
        <>
          <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 dark:border-slate-700 shadow-sm grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-4" role="search">
            <div className="md:col-span-2 lg:col-span-6">
              <label htmlFor="search-q" className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Search</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">search</span>
                <input
                  id="search-q"
                  type="search"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="e.g. GSTIN, Rohan, total, परीक्षा"
                  autoComplete="off"
                  onKeyDown={e => {
                    // Phones and tablets: the keyboard's Search key closes the keyboard and shows the results.
                    if (e.key !== 'Enter' || !window.matchMedia('(width < 64rem)').matches) return;
                    e.currentTarget.blur();
                    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className={inputClass}
                  data-testid="search-input"
                />
              </div>
            </div>
            <div className="lg:col-span-3">
              <label htmlFor="search-type" className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Document type</label>
              <select id="search-type" value={type} onChange={e => setType(e.target.value)} className={selectClass} data-testid="search-type">
                <option value="">All types</option>
                {DOC_TYPE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div className="lg:col-span-3">
              <label htmlFor="search-confidence" className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Confidence</label>
              <select id="search-confidence" value={minConfidence} onChange={e => setMinConfidence(e.target.value)} className={selectClass} data-testid="search-confidence">
                {CONFIDENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div ref={resultsRef} aria-live="polite" className="scroll-mt-20">
            {error ? (
              <div role="alert" className="bg-red-50 text-red-500 p-6 rounded-2xl border border-red-100 text-center">{error}</div>
            ) : loading && !results ? (
              <div className="flex justify-center py-20">
                <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
              </div>
            ) : results === null ? (
              <div className="text-center py-20 px-6 md:px-0 bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700">
                <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">manage_search</span>
                <p className="text-slate-500 font-medium">Type a name, number, amount or any word to search your documents.</p>
              </div>
            ) : results.length === 0 ? (
              <div className="text-center py-20 px-6 md:px-0 bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700">
                <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">search_off</span>
                <p className="text-slate-500 font-medium">No matches. Try another word or loosen the filters.</p>
              </div>
            ) : (
              <div className="space-y-4" data-testid="search-results">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  {results.length} {results.length === 1 ? 'match' : 'matches'}{loading ? ' · updating…' : ''}
                </p>
                <AnimatePresence initial={false}>
                  {results.map((hit, idx) => {
                    const key = `${hit.documentId}-${hit.kind}-${hit.fieldKey || hit.page || idx}-${idx}`;
                    return (
                      <motion.button
                        key={key}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        onClick={() => open(hit, key)}
                        disabled={opening === key}
                        className="w-full text-left bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-lg transition-shadow group"
                        aria-label={`Open ${hit.title}${hit.kind === 'field' ? `, field ${hit.label}` : ''}`}
                        data-testid="search-hit"
                      >
                        <div className="flex flex-wrap justify-between items-start gap-3 mb-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="material-symbols-outlined text-primary text-sm">description</span>
                            <p className="text-[11px] font-bold text-primary max-md:line-clamp-2 max-md:break-words md:truncate">{hit.title}</p>
                            <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded-full text-[9px] font-black text-slate-500 uppercase tracking-widest border border-slate-200 dark:border-slate-700 shrink-0">
                              {hit.docTypeLabel}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {hit.page && <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">p.{hit.page}</span>}
                            {hit.confidence != null && <ConfidenceChip value={hit.confidence} />}
                          </div>
                        </div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant mb-1">
                          {KIND_LABELS[hit.kind]}{hit.kind === 'field' || hit.kind === 'entity' ? ` · ${hit.label}` : ''}
                        </p>
                        <p className="text-sm text-on-surface leading-relaxed break-words">
                          <Highlighted text={hit.snippet} ranges={hit.highlights} />
                        </p>
                        <div className="flex justify-between items-center gap-2 md:gap-0 mt-3">
                          <span className="text-[10px] text-on-surface-variant min-w-0 max-md:break-words md:truncate">{hit.filename} · document confidence {percent(hit.overallConfidence)}</span>
                          <span className="material-symbols-outlined shrink-0 text-slate-300 group-hover:text-primary group-hover:translate-x-1 transition-all">
                            {opening === key ? 'hourglass_top' : 'arrow_forward'}
                          </span>
                        </div>
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
