import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import { ConfidenceChip } from './DocumentScreen';
import type { DocumentSummary, SavedGraph, User } from '../types';

const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
  'Computer Science': { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20' },
  'Mathematics': { bg: 'bg-secondary/10', text: 'text-secondary', border: 'border-secondary/20' },
  'Physics': { bg: 'bg-tertiary/10', text: 'text-tertiary', border: 'border-tertiary/20' },
  default: { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-600 dark:text-slate-300', border: 'border-slate-200 dark:border-slate-600' },
};
const getCategoryStyle = (cat: string) => categoryColors[cat] || categoryColors.default;

interface HistoryScreenProps {
  onLoadGraph: (graph: SavedGraph) => void;
  onOpenDocument: (id: string) => Promise<void>;
  onSearchClick: () => void;
  user: User | null;
  onSignInClick: () => void;
}

export function HistoryScreen({ onLoadGraph, onOpenDocument, onSearchClick, user, onSignInClick }: HistoryScreenProps) {
  const [graphs, setGraphs] = useState<SavedGraph[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch<{ graphs: SavedGraph[] }>('/graphs'),
      apiFetch<{ documents: DocumentSummary[] }>('/documents'),
    ])
      .then(([g, d]) => {
        if (cancelled) return;
        setGraphs(g.graphs);
        setDocuments(d.documents);
      })
      .catch(err => !cancelled && setError(err.message || 'Failed to fetch saved graphs'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [user]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this saved map?')) return;
    setDeletingId(id);
    try {
      await apiFetch(`/graphs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setGraphs(prev => prev.filter(g => g._id !== id));
    } catch (err: any) {
      setError(err.message || 'Could not delete the map.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteDocument = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this document and its extracted information?')) return;
    setDeletingId(id);
    try {
      await apiFetch(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setDocuments(prev => prev.filter(d => d.id !== id));
      // A document with a concept map is one record: remove its map too.
      setGraphs(prev => prev.filter(g => g._id !== id));
    } catch (err: any) {
      setError(err.message || 'Could not delete the document.');
    } finally {
      setDeletingId(null);
    }
  };

  const openDocument = async (id: string) => {
    setOpeningId(id);
    try {
      await onOpenDocument(id);
    } catch (err: any) {
      setError(err.message || 'Could not open the document.');
      setOpeningId(null);
    }
  };

  // Saved concept maps (unchanged cards).
  const renderGraphs = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <AnimatePresence>
        {graphs.map((item, idx) => {
          const catStyle = getCategoryStyle(item.metadata?.category || '');
          const id = item._id as string;
          return (
            <motion.div
              key={id}
              layout
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: Math.min(idx, 10) * 0.05 }}
              whileHover={{ y: -5 }}
              className="bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-lg transition-shadow cursor-pointer group overflow-hidden relative"
              onClick={() => onLoadGraph(item)}
              data-testid="history-card"
            >
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />

              <div className="flex justify-between items-start mb-5">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                  <span className="material-symbols-outlined">picture_as_pdf</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    {item.createdAt ? new Date(item.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
                  </span>
                  <button
                    onClick={e => handleDelete(e, id)}
                    disabled={deletingId === id}
                    aria-label="Delete saved map"
                    className="w-10 h-10 lg:w-8 lg:h-8 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-primary text-sm">description</span>
                <p className="text-[11px] font-bold text-primary truncate">{item.filename || 'Untitled.pdf'}</p>
              </div>

              <h4 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors max-lg:line-clamp-2 max-lg:break-words lg:truncate">
                {item.metadata?.title || 'Untitled Graph'}
              </h4>

              <p className="text-xs text-on-surface-variant line-clamp-3 mb-5 min-h-[42px]">
                {item.metadata?.description || 'Knowledge network generated from the uploaded document.'}
              </p>

              <div className="flex flex-wrap gap-2 mb-5">
                {item.metadata?.category && (
                  <span className={cn('px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border', catStyle.bg, catStyle.text, catStyle.border)}>
                    {item.metadata.category}
                  </span>
                )}
                {item.metadata?.complexity ? (
                  <span className="px-3 py-1 bg-slate-100 dark:bg-slate-700 rounded-full text-[9px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest border border-slate-200 dark:border-slate-600">
                    Level {item.metadata.complexity}
                  </span>
                ) : null}
                {item.fallbackUsed && (
                  <span className="px-3 py-1 bg-amber-50 rounded-full text-[9px] font-black text-amber-600 uppercase tracking-widest border border-amber-100">
                    Basic map
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 md:gap-0 pt-4 border-t border-slate-50">
                <div className="flex max-md:flex-wrap gap-2">
                  <span className="px-2.5 py-1 bg-slate-100 dark:bg-slate-700 rounded-lg text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                    <span className="material-symbols-outlined text-[10px]">hub</span>
                    {item.graph?.nodes?.length || 0} Nodes
                  </span>
                  <span className="px-2.5 py-1 bg-slate-100 dark:bg-slate-700 rounded-lg text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                    <span className="material-symbols-outlined text-[10px]">link</span>
                    {item.graph?.edges?.length || 0} Edges
                  </span>
                </div>
                <span className="material-symbols-outlined text-slate-300 group-hover:text-primary group-hover:translate-x-1 transition-all">
                  arrow_forward
                </span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );

  return (
    <div className="space-y-10 py-8">
      <div className="max-w-xl">
        <h2 className="text-4xl md:text-5xl font-headline font-bold mb-4">Saved Networks</h2>
        <p className="text-on-surface-variant leading-relaxed">
          Every PDF you analyze while signed in is saved here. Click a card to open its knowledge graph again.
        </p>
      </div>

      {!user ? (
        <div className="text-center py-20 px-6 md:px-0 bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">lock</span>
          <p className="text-slate-500 font-medium mb-4">Sign in to view your saved graphs.</p>
          <button onClick={onSignInClick} className="px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90">Sign In</button>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-20">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : error ? (
        <div role="alert" className="bg-red-50 text-red-500 p-6 rounded-2xl border border-red-100 text-center">
          {error}
        </div>
      ) : documents.length > 0 || graphs.length > 0 ? (
        <div className="space-y-12">
          {documents.length > 0 && (
            <section className="space-y-6" aria-label="Extracted documents">
              <div className="flex justify-between items-end gap-4">
                <h3 className="text-3xl font-headline font-bold">Extracted Documents</h3>
                <button
                  onClick={onSearchClick}
                  className="flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-sm">search</span>
                  Search
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <AnimatePresence>
                  {documents.map((doc, idx) => (
                    <motion.div
                      key={doc.id}
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ delay: Math.min(idx, 10) * 0.05 }}
                      whileHover={{ y: -5 }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${doc.title || doc.filename}`}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openDocument(doc.id))}
                      className="bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-lg transition-shadow cursor-pointer group overflow-hidden relative"
                      onClick={() => openDocument(doc.id)}
                      data-testid="document-card"
                    >
                      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />

                      <div className="flex justify-between items-start mb-5">
                        <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                          <span className="material-symbols-outlined">{doc.mimeType?.startsWith('image/') ? 'image' : 'plagiarism'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                            {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
                          </span>
                          <button
                            onClick={e => handleDeleteDocument(e, doc.id)}
                            disabled={deletingId === doc.id}
                            aria-label="Delete saved document"
                            className="w-10 h-10 lg:w-8 lg:h-8 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                          >
                            <span className="material-symbols-outlined text-lg">delete</span>
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 mb-2">
                        <span className="material-symbols-outlined text-primary text-sm">description</span>
                        <p className="text-[11px] font-bold text-primary truncate">{doc.filename}</p>
                      </div>

                      <h4 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors max-lg:line-clamp-2 max-lg:break-words lg:truncate">{doc.title || doc.docTypeLabel}</h4>

                      <p className="text-xs text-on-surface-variant line-clamp-3 mb-5 min-h-[42px]">{doc.summary}</p>

                      <div className="flex flex-wrap gap-2 mb-5">
                        <span className="px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border bg-primary/10 text-primary border-primary/20">
                          {doc.docTypeLabel}
                        </span>
                        <ConfidenceChip value={doc.overallConfidence} className="px-3 py-1" />
                        {doc.ocrUsed && (
                          <span className="px-3 py-1 bg-secondary/10 rounded-full text-[9px] font-black text-secondary uppercase tracking-widest border border-secondary/20">OCR</span>
                        )}
                        {doc.fallbackUsed && (
                          <span className="px-3 py-1 bg-amber-50 rounded-full text-[9px] font-black text-amber-600 uppercase tracking-widest border border-amber-100">Basic extraction</span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 md:gap-0 pt-4 border-t border-slate-50">
                        <div className="flex max-md:flex-wrap gap-2">
                          <span className="px-2.5 py-1 bg-slate-100 dark:bg-slate-700 rounded-lg text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                            <span className="material-symbols-outlined text-[10px]">list_alt</span>
                            {doc.fieldCount} Fields
                          </span>
                          <span className={cn(
                            'px-2.5 py-1 rounded-lg text-[9px] font-bold uppercase flex items-center gap-1',
                            doc.issueCounts.error ? 'bg-red-50 text-red-500' : doc.issueCounts.warning ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                          )} title={`${doc.issueCounts.error} errors, ${doc.issueCounts.warning} warnings`}>
                            <span className="material-symbols-outlined text-[10px]">{doc.issueCounts.error ? 'error' : doc.issueCounts.warning ? 'warning' : 'check_circle'}</span>
                            {doc.issueCounts.total} {doc.issueCounts.total === 1 ? 'Issue' : 'Issues'}
                          </span>
                        </div>
                        <span className="material-symbols-outlined text-slate-300 group-hover:text-primary group-hover:translate-x-1 transition-all" aria-hidden="true">
                          {openingId === doc.id ? 'hourglass_top' : 'arrow_forward'}
                        </span>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}
          {graphs.length > 0 && (documents.length > 0 ? (
            <section className="space-y-6" aria-label="Knowledge graphs">
              <h3 className="text-3xl font-headline font-bold">Knowledge Graphs</h3>
              {renderGraphs()}
            </section>
          ) : renderGraphs())}
        </div>
      ) : (
        <div className="text-center py-20 px-6 md:px-0 bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">folder_open</span>
          <p className="text-slate-500 font-medium">No saved graphs yet. Upload a PDF to create your first one.</p>
        </div>
      )}
    </div>
  );
}
