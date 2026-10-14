import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { TopAppBar, BottomNavBar } from './components/Navigation';
import { AuthModal } from './components/AuthModal';
import { UploadZone, type ExtractedUpload } from './components/UploadZone';
import { StatusPanel } from './components/StatusPanel';
import { ConceptCard } from './components/ConceptCard';
import { HeroScreen } from './components/HeroScreen';
import { GraphScreen } from './components/GraphScreen';
import { DetailsScreen } from './components/DetailsScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { DocumentScreen } from './components/DocumentScreen';
import { PacketScreen } from './components/PacketScreen';
import { SearchScreen, type SearchMode } from './components/SearchScreen';
import { AskCitation, AskTurn, Concept, ConceptCategory, DocumentResult, GraphData, GraphMode, SavedGraph, SearchHit, SourceFocus, UploadStatus, User } from './types';
import { ApiError, apiFetch, exportDocument, fetchCurrentUser, setToken, toGraphData } from './lib/api';
import { cn } from './lib/utils';
import { ProcessingModeToggle } from './components/ProcessingModeToggle';
import { applyDocumentFieldPolicy } from './lib/fieldPolicy';

export type Screen = 'hero' | 'upload' | 'document' | 'graph' | 'details' | 'history' | 'search' | 'packets';

const LAST_GRAPH_KEY = 'doxentra_last_graph';
const NO_NODES = new Set<string>();
const LAST_DOCS_KEY = 'doxentra_last_docs';
const MASK_KEY = 'doxentra_mask_pii';

const CATEGORY_BY_TYPE: Record<string, ConceptCategory> = {
  major: 'Core Concept',
  header: 'Main Topic',
  'sub-topic': 'Sub-topic',
  concept: 'Key Detail',
};

function loadLastGraph(): GraphData | null {
  try {
    const raw = sessionStorage.getItem(LAST_GRAPH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadLastDocs(): DocumentResult[] {
  try {
    const raw = sessionStorage.getItem(LAST_DOCS_KEY);
    return raw ? JSON.parse(raw).map(applyDocumentFieldPolicy) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('hero');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(loadLastGraph);
  const [viewedNodeIds, setViewedNodeIds] = useState<Set<string>>(new Set());
  // Document intelligence: documents of this session, the open one, and the selected field.
  const [recentDocs, setRecentDocs] = useState<DocumentResult[]>(loadLastDocs);
  const [currentDocId, setCurrentDocId] = useState<string | null>(() => loadLastDocs()[0]?.id ?? null);
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);
  // A cited passage (not a field) to show on its page.
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
  // Search screen: plain search or questions to the documents (kept while navigating).
  const [searchMode, setSearchMode] = useState<SearchMode>('search');
  const [askTurns, setAskTurns] = useState<AskTurn[]>([]);
  const [askScope, setAskScope] = useState('');
  // Personal data masked on the document page, in exports and in the entity graph (kept per tab).
  const [maskPii, setMaskPii] = useState(() => {
    try {
      return sessionStorage.getItem(MASK_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [maskedDoc, setMaskedDoc] = useState<{ doc: DocumentResult | null; error: string | null }>({ doc: null, error: null });
  // Graph screen: the concept map, or the people & documents of the workspace.
  const [graphMode, setGraphMode] = useState<GraphMode>('concepts');
  const [entityGraph, setEntityGraph] = useState<{ data: GraphData | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  // Original files of this session, so a concept map can be built without signing in.
  const uploadedFiles = useRef(new Map<string, File>());
  const currentDoc = recentDocs.find(d => d.id === currentDocId) || null;

  // Scroll to top on screen change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [currentScreen]);

  // Restore the signed-in user from the saved token
  useEffect(() => {
    fetchCurrentUser().then(u => u && setUser(u));
  }, []);

  // Keep the current map across page reloads (per browser tab)
  useEffect(() => {
    try {
      if (graphData) sessionStorage.setItem(LAST_GRAPH_KEY, JSON.stringify(graphData));
    } catch {
      /* storage full or unavailable */
    }
  }, [graphData]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_DOCS_KEY, JSON.stringify(recentDocs.slice(0, 10)));
    } catch {
      /* storage full or unavailable */
    }
  }, [recentDocs]);

  useEffect(() => {
    try {
      sessionStorage.setItem(MASK_KEY, maskPii ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [maskPii]);

  // The masked document comes from the server, so nothing personal is ever rendered.
  useEffect(() => {
    if (!maskPii || !currentDoc) return;
    let cancelled = false;
    apiFetch<DocumentResult>(`/documents/${encodeURIComponent(currentDoc.id)}?redact=1`)
      .then(doc => !cancelled && setMaskedDoc({ doc, error: null }))
      .catch(err => !cancelled && setMaskedDoc({ doc: null, error: err instanceof ApiError && err.status === 404
        ? 'This result is not saved for this account, so it cannot be masked. Upload it again to mask it.'
        : err instanceof Error ? err.message : 'Could not mask this document.' }));
    return () => {
      cancelled = true;
    };
  }, [maskPii, currentDoc?.id, currentDoc?.auditCount]);

  // The entity graph is rebuilt each time it is shown: documents change in between.
  useEffect(() => {
    if (currentScreen !== 'graph' || graphMode !== 'entities') return;
    let cancelled = false;
    setEntityGraph(g => ({ ...g, loading: true, error: null }));
    apiFetch<GraphData>(`/entity-graph${maskPii ? '?redact=1' : ''}`)
      .then(g => !cancelled && setEntityGraph({ data: { ...g, filename: '', kind: 'entities' }, loading: false, error: null }))
      .catch(err => !cancelled && setEntityGraph({ data: null, loading: false, error: err instanceof Error ? err.message : 'Could not load the graph.' }));
    return () => {
      cancelled = true;
    };
  }, [currentScreen, graphMode, user?.id, recentDocs.length, maskPii]);

  const concepts: Concept[] = useMemo(() => {
    if (!graphData) return [];
    const order = ['major', 'header', 'sub-topic', 'concept'];
    return [...graphData.nodes]
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || (b.importance || 0) - (a.importance || 0))
      .slice(0, 12)
      .map(n => ({
        id: n.id,
        title: n.label,
        description: n.desc || 'Concept extracted from your document.',
        category: CATEGORY_BY_TYPE[n.type] || 'Key Detail',
        tags: [graphData.metadata.category || 'General'].filter(Boolean),
      }));
  }, [graphData]);

  const showGraph = (item: SavedGraph) => {
    setGraphData(toGraphData(item));
    setGraphMode('concepts');
    setViewedNodeIds(new Set());
    setCurrentScreen('graph');
  };

  const showDocument = (doc: DocumentResult, fieldKey: string | null = null, focus: SourceFocus | null = null) => {
    setRecentDocs(prev => [doc, ...prev.filter(d => d.id !== doc.id)].slice(0, 10));
    setCurrentDocId(doc.id);
    setSelectedFieldKey(fieldKey);
    setSourceFocus(fieldKey ? null : focus);
    setCurrentScreen('document');
  };

  const onDocumentsReady = (results: ExtractedUpload[], open: boolean) => {
    for (const r of results) uploadedFiles.current.set(r.doc.id, r.file);
    const docs = results.map(r => r.doc);
    // The batch first (last uploaded on top), then earlier documents.
    setRecentDocs(prev => [...[...docs].reverse(), ...prev.filter(d => !docs.some(n => n.id === d.id))].slice(0, 10));
    setCurrentDocId(docs[docs.length - 1].id);
    setSelectedFieldKey(null);
    if (open) setCurrentScreen('document');
  };

  const openDocumentById = async (id: string, fieldKey: string | null = null, focus: SourceFocus | null = null) => {
    const doc = await apiFetch<DocumentResult>(`/documents/${encodeURIComponent(id)}`);
    showDocument(doc, fieldKey, focus);
  };

  const openSearchHit = (hit: SearchHit) =>
    openDocumentById(
      hit.documentId,
      hit.kind === 'field' || hit.kind === 'issue' ? hit.fieldKey || null : null,
      hit.kind === 'text' || hit.kind === 'entity' ? { page: hit.page, quote: hit.sourceQuote || hit.snippet.replace(/^…|…$/g, ''), label: hit.label } : null,
    );

  const openCitation = (c: AskCitation) =>
    openDocumentById(c.documentId, c.kind === 'field' ? c.fieldKey || null : null, c.kind === 'text' ? { page: c.page, quote: c.quote, label: `Cited passage · page ${c.page}` } : null);

  /** Ask questions about the open document. */
  const askAboutDocument = () => {
    if (currentDoc) setAskScope(currentDoc.id);
    setSearchMode('ask');
    setCurrentScreen('search');
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!currentDoc) return;
    const named = maskPii && maskedDoc.doc?.id === currentDoc.id ? maskedDoc.doc : currentDoc;
    try {
      await exportDocument(named, format, true, maskPii);
    } catch (err) {
      // Not saved for this account or guest workspace: export what is on screen.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return exportDocument(currentDoc, format, false, maskPii);
      throw err;
    }
  };

  /** Concept map / roadmap / quiz for the open document. */
  const buildConceptMap = async () => {
    if (!currentDoc) return;
    const done = (data: SavedGraph) => {
      setRecentDocs(prev => prev.map(d => (d.id === currentDoc.id ? { ...d, hasGraph: true } : d)));
      showGraph(data);
    };
    try {
      return done(await apiFetch<SavedGraph>(`/documents/${encodeURIComponent(currentDoc.id)}/concept-map`, { method: 'POST' }));
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 401))) throw err;
    }
    // Not saved for this account or guest workspace: run the original concept-map upload.
    const file = uploadedFiles.current.get(currentDoc.id);
    if (!file) throw new Error('Sign in, or upload the file again, to build a concept map from this document.');
    const form = new FormData();
    form.append('pdf', file);
    done(await apiFetch<SavedGraph>('/upload', { method: 'POST', body: form }));
  };

  const onNodeExplored = (nodeId: string) => {
    setViewedNodeIds(prev => (prev.has(nodeId) ? prev : new Set(prev).add(nodeId)));
  };

  const handleAuth = (authedUser: User) => {
    setUser(authedUser);
    setShowAuthModal(false);
  };

  const handleSignOut = () => {
    setUser(null);
    setToken(null);
    if (currentScreen === 'history') setCurrentScreen('hero');
  };

  const renderScreen = () => {
    switch (currentScreen) {
      case 'packets':
        return maskPii ? <div className="max-w-xl mx-auto py-24 px-6 text-center space-y-4"><h2 className="text-2xl font-bold">Packet review is hidden while personal data is masked</h2><p className="text-sm text-on-surface-variant">The case view includes source pages, values and reviewer findings.</p><button onClick={() => setMaskPii(false)} className="px-5 py-2.5 bg-primary text-white rounded-full text-sm font-bold">Show packet details</button></div>
          : <PacketScreen onOpenDocument={(id, fieldKey = null, quote = null, page = null) =>
              { void openDocumentById(id, fieldKey, !fieldKey && quote ? { page, quote, label: 'Policy source' } : null); }} />;
      case 'hero':
        return <HeroScreen
          onStartJourney={() => setCurrentScreen('upload')}
          onOpenSaved={() => (user ? setCurrentScreen('history') : setShowAuthModal(true))}
          isSignedIn={!!user}
        />;
      case 'graph':
        return graphMode === 'entities'
          ? <GraphScreen
              key="entities"
              data={entityGraph.data}
              mode="entities"
              onModeChange={setGraphMode}
              loading={entityGraph.loading}
              error={entityGraph.error}
              onNodeExplored={() => {}}
              viewedNodeIds={NO_NODES}
              onUploadClick={() => setCurrentScreen('upload')}
              onOpenDocument={(id, fieldKey) => openDocumentById(id, fieldKey)}
            />
          : <GraphScreen key="concepts" data={graphData} mode="concepts" onModeChange={setGraphMode} onNodeExplored={onNodeExplored} viewedNodeIds={viewedNodeIds} onUploadClick={() => setCurrentScreen('upload')} />;
      case 'details':
        return <DetailsScreen data={graphData} viewedNodeIds={viewedNodeIds} onNavigate={setCurrentScreen} masked={maskPii} onOpenDocument={id => openDocumentById(id)} />;
      case 'history':
        return <HistoryScreen
          onLoadGraph={showGraph}
          onOpenDocument={id => openDocumentById(id)}
          onSearchClick={() => setCurrentScreen('search')}
          user={user}
          onSignInClick={() => setShowAuthModal(true)}
        />;
      case 'document':
        if (maskPii && currentDoc && maskedDoc.doc?.id !== currentDoc.id) {
          return (
            <div className="py-24 text-center space-y-5" data-testid="masking">
              <p className={cn('font-medium', maskedDoc.error ? 'text-red-500' : 'text-slate-500')}>{maskedDoc.error || 'Masking personal data…'}</p>
              {maskedDoc.error && (
                <button onClick={() => setMaskPii(false)} className="px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90">
                  Show personal data
                </button>
              )}
            </div>
          );
        }
        return <DocumentScreen
          doc={maskPii && currentDoc ? maskedDoc.doc : currentDoc}
          masked={maskPii}
          onToggleMask={() => setMaskPii(m => !m)}
          onEntityGraph={() => { setGraphMode('entities'); setCurrentScreen('graph'); }}
          recentDocs={recentDocs}
          selectedFieldKey={selectedFieldKey}
          onSelectField={key => { setSelectedFieldKey(key); setSourceFocus(null); }}
          onSelectDoc={d => { setCurrentDocId(d.id); setSelectedFieldKey(null); setSourceFocus(null); }}
          onUploadClick={() => setCurrentScreen('upload')}
          onExport={handleExport}
          onBuildConceptMap={buildConceptMap}
          onAsk={askAboutDocument}
          focus={sourceFocus}
          onClearFocus={() => setSourceFocus(null)}
          onOpenDocument={(id, fieldKey) => openDocumentById(id, fieldKey)}
          onDocumentChange={maskPii ? undefined : updated => setRecentDocs(prev => prev.map(d => (d.id === updated.id ? updated : d)))}
        />;
      case 'search':
        return <SearchScreen
          user={user}
          onSignInClick={() => setShowAuthModal(true)}
          onOpenHit={openSearchHit}
          mode={searchMode}
          onModeChange={setSearchMode}
          askTurns={askTurns}
          setAskTurns={setAskTurns}
          askScope={askScope}
          setAskScope={setAskScope}
          onOpenCitation={openCitation}
        />;
      case 'upload':
      default:
        return (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Discovered Concepts */}
            <div className="lg:col-span-7 order-2 lg:order-1">
              <div className="bg-surface-container-low rounded-xl p-5 sm:p-6 md:p-8 lg:min-h-[600px] flex flex-col border border-slate-200">
                <div className="flex flex-wrap lg:flex-nowrap justify-start md:justify-between items-center mb-6 md:mb-10 gap-4 gap-y-3">
                  <div className="basis-full md:basis-auto">
                    <h3 className="text-xl sm:text-2xl font-headline font-bold">Discovered Concepts</h3>
                    <p className="text-[10px] text-on-surface-variant uppercase tracking-[0.2em] mt-1 max-lg:wrap-anywhere">
                      {graphData ? graphData.filename : 'Waiting for a document'}
                    </p>
                  </div>
                  {currentDoc && (
                    <button
                      onClick={() => setCurrentScreen('document')}
                      className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full text-[10px] text-primary font-bold uppercase hover:bg-primary/20 transition-colors shrink-0"
                    >
                      <span className="material-symbols-outlined text-sm">plagiarism</span>
                      Open Results
                    </button>
                  )}
                  {graphData && (
                    <button
                      onClick={() => setCurrentScreen('graph')}
                      className="flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors shrink-0"
                    >
                      <span className="material-symbols-outlined text-sm">account_tree</span>
                      Open Graph
                    </button>
                  )}
                </div>

                {concepts.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <AnimatePresence mode="popLayout">
                      {concepts.map((concept) => (
                        <ConceptCard key={concept.id} concept={concept} />
                      ))}
                    </AnimatePresence>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-slate-400">
                    <span className="material-symbols-outlined text-6xl mb-4 text-slate-300">hub</span>
                    <p className="font-medium text-slate-500">No concepts yet</p>
                    <p className="text-sm mt-1 max-w-xs">Upload a PDF and the key concepts from it will appear here.</p>
                  </div>
                )}

                {graphData && (
                  <div className="mt-auto pt-8">
                    <p className="text-[10px] font-mono text-primary/60 tracking-widest uppercase">
                      {graphData.nodes.length} concepts · {graphData.edges.length} connections
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Upload Zone */}
            <div className="lg:col-span-5 space-y-8 order-1 lg:order-2">
              <section>
                <motion.h2
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-4xl font-headline font-bold mb-2"
                >
                  Knowledge Extraction
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-on-surface-variant leading-relaxed"
                >
                  Upload forms, certificates, invoices or reports — PDFs, scans or photos — and the AI will classify them, extract key fields and flag missing or inconsistent details.
                </motion.p>
                {!user && (
                  <p className="text-xs text-slate-500 mt-3">
                    <button onClick={() => setShowAuthModal(true)} className="relative text-primary font-bold hover:underline max-lg:after:absolute max-lg:after:-inset-x-1 max-lg:after:-inset-y-2.5">Sign in</button> to save your documents and maps to History.
                  </p>
                )}
              </section>

              <ProcessingModeToggle />
              <UploadZone onDocumentsReady={onDocumentsReady} setUploads={setUploads} />

              <AnimatePresence>
                {uploads.length > 0 && (
                  <StatusPanel uploads={uploads} />
                )}
              </AnimatePresence>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen pb-32 overflow-x-clip">
      <TopAppBar
        user={user}
        onSignInClick={() => setShowAuthModal(true)}
        onSignOut={handleSignOut}
        currentScreen={currentScreen}
        onScreenChange={setCurrentScreen}
      />

      <main className="pt-24 px-4 md:px-6 max-w-7xl mx-auto">
        <motion.div
          key={currentScreen}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          {renderScreen()}
        </motion.div>
      </main>

      <BottomNavBar currentScreen={currentScreen} onScreenChange={setCurrentScreen} user={user} />

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuth={handleAuth}
      />

      {/* Decorative Glows */}
      <div className="fixed top-[-10%] right-[-10%] w-[50%] h-[50%] bg-primary/3 blur-[120px] rounded-full -z-10 pointer-events-none"></div>
      <div className="fixed bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-secondary/3 blur-[120px] rounded-full -z-10 pointer-events-none"></div>
    </div>
  );
}
