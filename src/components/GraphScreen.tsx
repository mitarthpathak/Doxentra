import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence, useMotionValue, animate } from 'motion/react';
import * as d3 from 'd3-force';
import { cn } from '../lib/utils';
import type { CrossDocumentIssue, GraphData, GraphEdge, GraphMode, GraphNode } from '../types';
import { IntegrityCard, ConflictComparison } from './IntegrityCard';

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

const RING: Record<string, number> = { major: 0, header: 250, 'sub-topic': 450, concept: 630 };

/** Runs the force simulation to completion once, synchronously. */
function computeLayout(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  const simNodes: any[] = nodes.map((n, i) => {
    // Start on the node's ring so the layout converges quickly and deterministically.
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const r = RING[n.type] ?? 700;
    return { ...n, x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
  const byId = new Map(simNodes.map(n => [n.id, n]));
  const links = edges
    .filter(e => byId.has(e.source) && byId.has(e.target))
    .map(e => ({ source: e.source, target: e.target, tree: e.label === 'contains' }));

  const sim = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink(links).id((d: any) => d.id)
      .distance((l: any) => {
        const types = [l.source.type, l.target.type];
        if (types.includes('major')) return 250;
        if (types.includes('header')) return 190;
        return 150;
      })
      .strength((l: any) => (l.tree ? 0.7 : 0.05)))
    .force('charge', d3.forceManyBody().strength((d: any) => (d.type === 'major' ? -2000 : d.type === 'header' ? -900 : -400)))
    .force('collide', d3.forceCollide().radius((d: any) => (d.type === 'major' ? 140 : d.type === 'header' ? 110 : d.type === 'sub-topic' ? 90 : 72)).iterations(2))
    .force('radial', d3.forceRadial((d: any) => RING[d.type] ?? 700, 0, 0).strength(0.6))
    .stop();

  const root = simNodes.find(n => n.type === 'major');
  for (let i = 0; i < 300; i++) {
    sim.tick();
    if (root) { root.x = 0; root.y = 0; }
  }
  return simNodes.map(n => ({ ...n, x: Math.round(n.x), y: Math.round(n.y) }));
}

interface GraphScreenProps {
  data: GraphData | null;
  onNodeExplored: (id: string) => void;
  viewedNodeIds: Set<string>;
  onUploadClick: () => void;
  /** Concept map of one document, or the people & documents of the workspace. */
  mode?: GraphMode;
  onModeChange?: (mode: GraphMode) => void;
  loading?: boolean;
  error?: string | null;
  onOpenDocument?: (id: string, fieldKey: string | null) => void;
}

const SEVERITY_RING: Record<string, string> = { error: 'ring-2 ring-red-400 ring-offset-2', warning: 'ring-2 ring-amber-400 ring-offset-2', info: '' };
const SEVERITY_BOX: Record<string, string> = { error: 'bg-red-50 border-red-100 text-red-700', warning: 'bg-amber-50 border-amber-100 text-amber-700', info: 'bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300' };

/** Concept map ↔ people & documents (same tabs as Search ↔ Ask). */
function ModeTabs({ mode, onModeChange }: { mode: GraphMode; onModeChange?: (mode: GraphMode) => void }) {
  if (!onModeChange) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-4" role="tablist" aria-label="Graph view">
      {([['concepts', 'account_tree', 'Concepts'], ['entities', 'groups', 'People & documents']] as const).map(([key, icon, label]) => (
        <button
          key={key}
          role="tab"
          aria-selected={mode === key}
          onClick={() => onModeChange(key)}
          className={cn(
            'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-full text-[10px] font-bold uppercase whitespace-nowrap transition-colors',
            mode === key ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'
          )}
          data-testid={`graph-mode-${key}`}
        >
          <span className="material-symbols-outlined text-sm">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}

export function GraphScreen({ data, onNodeExplored, viewedNodeIds, onUploadClick, mode = 'concepts', onModeChange, loading = false, error = null, onOpenDocument }: GraphScreenProps) {
  const entities = mode === 'entities';
  const [zoom, setZoom] = useState(0.6);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<PositionedNode | null>(null);
  const [selectedConflict, setSelectedConflict] = useState<CrossDocumentIssue | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panX = useMotionValue(0);
  const panY = useMotionValue(0);

  const nodes = useMemo(() => (data?.nodes?.length ? computeLayout(data.nodes, data.edges || []) : []), [data]);
  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const edges = useMemo(
    () => (data?.edges || []).filter(e => nodeById.has(e.source) && nodeById.has(e.target)),
    [data, nodeById]
  );
  const issueForEdge = (edge: GraphEdge): CrossDocumentIssue => data?.issues?.find(issue =>
    [edge.source, edge.target].every(id => { const node = nodeById.get(id); return issue.refs.some(ref => ref.documentId === node?.documentId && (!node?.fieldKey || ref.fieldKey === node.fieldKey)); })
    && issue.message === edge.message) || ({
    rule: 'graph.mismatch', type: 'cross_document', severity: edge.severity || 'warning', message: edge.message || 'These values disagree.',
    refs: [edge.source, edge.target].map(id => {
      const node = nodeById.get(id)!;
      const source = nodeById.get(`doc:${node.documentId}`);
      return { documentId: node.documentId || '', fieldKey: node.fieldKey || null, title: source?.label || 'Document', filename: source?.desc?.split(' · ')[1]?.split('.')[0] || source?.label || 'Document', docType: source?.caption || 'Document', value: node.label.includes(':') ? node.label.slice(node.label.indexOf(':') + 1).trim() : node.label };
    }),
  });
  const graphIssues = data?.issues || edges.filter(e => e.kind === 'mismatch').map(issueForEdge);
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [edges]);

  // Zoom level that fits the whole graph in the viewport.
  const fitZoom = useCallback(() => {
    const el = containerRef.current;
    if (!el || nodes.length === 0) return 0.6;
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const w = Math.max(...xs) - Math.min(...xs) + 300;
    const h = Math.max(...ys) - Math.min(...ys) + 200;
    // Never shrink so far that labels become unreadable; the user can pan instead.
    const minReadable = el.clientWidth < 700 ? 0.45 : 0.6;
    return Math.max(minReadable, Math.min(1.1, el.clientWidth / w, el.clientHeight / h));
  }, [nodes]);

  const resetView = useCallback(() => {
    setZoom(fitZoom());
    animate(panX, 0, { duration: 0.4 });
    animate(panY, 0, { duration: 0.4 });
  }, [fitZoom, panX, panY]);

  useEffect(() => {
    resetView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, isMaximized]);

  // Mouse-wheel / trackpad zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => Math.min(3, Math.max(0.15, z * (e.deltaY > 0 ? 0.9 : 1.1))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [nodes.length]);

  // Escape leaves full-screen mode
  useEffect(() => {
    if (!isMaximized) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !selectedNode && setIsMaximized(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMaximized, selectedNode]);

  const handleNodeClick = (node: PositionedNode) => {
    setSelectedNode(node);
    onNodeExplored(node.id);
  };

  if (!data || nodes.length === 0 || (entities && nodes.length < 2)) {
    return (
      <div className="py-8 space-y-8">
        <IntegrityCard issues={data?.issues || []} onGraph={!entities ? () => onModeChange?.('entities') : undefined} />
        <div>
          <p className="text-[10px] font-bold text-primary uppercase tracking-widest">{entities ? 'Entity Graph' : 'Semantic Architecture'}</p>
          <h2 className="text-4xl md:text-5xl font-headline font-bold">{entities ? 'People & Documents' : 'Concept Galaxy'}</h2>
          <ModeTabs mode={mode} onModeChange={onModeChange} />
        </div>
        <div className="text-center py-24 px-6 md:px-0 bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700" data-testid="graph-empty">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">{entities ? 'groups' : 'account_tree'}</span>
          <p className={cn('font-medium mb-5', error ? 'text-red-500' : 'text-slate-500')}>
            {error || (loading ? 'Linking your documents…' : entities ? 'No documents yet. Upload documents to see the people and organisations in them.' : 'No knowledge graph yet. Upload a PDF to generate one.')}
          </p>
          {!loading && (
            <button onClick={onUploadClick} className="px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90">
              {entities ? 'Upload documents' : 'Upload a PDF'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const hoveredNeighbors = hoveredId ? neighbors.get(hoveredId) : undefined;
  const viewedCount = nodes.filter(n => viewedNodeIds.has(n.id)).length;

  return (
    <div className={cn('space-y-6 py-8 w-full', isMaximized ? 'fixed inset-0 z-[60] bg-background p-0 md:p-6 overflow-hidden flex flex-col' : 'max-w-full')}>
      {!isMaximized && <IntegrityCard issues={graphIssues} onOpenDocument={onOpenDocument} onGraph={!entities ? () => onModeChange?.('entities') : undefined} />}
      {selectedConflict && <ConflictComparison issue={selectedConflict} onClose={() => setSelectedConflict(null)} onOpenDocument={onOpenDocument} />}
      {!isMaximized && (
        <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4 w-full">
          <div>
            <p className="text-[10px] font-bold text-primary uppercase tracking-widest">{entities ? 'Entity Graph' : 'Semantic Architecture'}</p>
            <h2 className="text-4xl md:text-5xl font-headline font-bold break-words">{data.metadata?.title || 'Concept Galaxy'}</h2>
            <p className="text-on-surface-variant leading-relaxed max-w-lg mt-2">
              {entities
                ? 'Who your documents are about and where they disagree: red dashed lines join values that conflict. Click a node for details.'
                : 'Click any concept to read its explanation. Drag to pan, scroll or use the buttons to zoom.'}
            </p>
            <ModeTabs mode={mode} onModeChange={onModeChange} />
          </div>
          {entities ? (
            <div className="bg-surface-container-high px-5 py-2 md:px-8 md:py-4 rounded-[32px] border border-slate-200 dark:border-slate-700 shadow-sm text-center self-start md:self-auto flex items-center gap-3 md:block">
              <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Conflicts</p>
              <p className={cn('text-2xl md:text-3xl font-headline font-bold', data.stats?.mismatches ? 'text-red-500' : 'text-tertiary')} data-testid="graph-conflicts">
                {data.stats?.mismatches ?? 0} <span className="text-sm text-slate-400">/ {data.stats?.documents ?? 0} docs</span>
              </p>
            </div>
          ) : (
          <div className="bg-surface-container-high px-5 py-2 md:px-8 md:py-4 rounded-[32px] border border-slate-200 dark:border-slate-700 shadow-sm text-center self-start md:self-auto flex items-center gap-3 md:block">
            <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Explored</p>
            <p className="text-2xl md:text-3xl font-headline font-bold text-primary" data-testid="mastery">
              {viewedCount} <span className="text-sm text-slate-400">/ {nodes.length}</span>
            </p>
          </div>
          )}
        </div>
      )}

      {!isMaximized && data.fallbackUsed && (
        <div className="px-5 py-3 bg-amber-50 border border-amber-100 rounded-2xl text-sm text-amber-700">
          This is a basic keyword map because the AI service was unavailable. Upload the PDF again later for a full AI analysis.
        </div>
      )}

      <div
        className={cn(
          'relative w-full bg-surface-container-low border border-slate-200 dark:border-slate-700 overflow-hidden cursor-grab active:cursor-grabbing shadow-inner',
          isMaximized ? 'flex-1 md:rounded-[32px]' : 'h-[70vh] min-h-[480px] max-h-[850px] rounded-[40px]'
        )}
        ref={containerRef}
        data-testid="graph-canvas"
      >
        <motion.div drag style={{ x: panX, y: panY }} dragMomentum={false} className="absolute inset-0">
          <motion.div
            className="absolute left-1/2 top-1/2 w-0 h-0"
            animate={{ scale: zoom }}
            transition={{ type: 'spring', bounce: 0.1, duration: 0.4 }}
          >
            {/* Edges */}
            <svg className="absolute overflow-visible pointer-events-none" width="1" height="1" style={{ left: 0, top: 0 }}>
              {edges.map((edge, i) => {
                const s = nodeById.get(edge.source)!;
                const t = nodeById.get(edge.target)!;
                const isHoveredEdge = hoveredId !== null && (hoveredId === s.id || hoveredId === t.id);
                const isViewedEdge = viewedNodeIds.has(s.id) && viewedNodeIds.has(t.id);
                const isCross = edge.label !== 'contains';
                const isMismatch = edge.kind === 'mismatch';
                const opacity = hoveredId ? (isHoveredEdge ? 1 : isMismatch ? 0.2 : 0.06) : isMismatch ? 0.9 : isViewedEdge ? 0.7 : isCross ? 0.25 : 0.45;
                const width = Math.max(1.5, (edge.importance || 5) * 0.6);
                return (
                  <line
                    key={i}
                    x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                    stroke={isMismatch ? '#ef4444' : isHoveredEdge ? 'var(--color-primary)' : isViewedEdge ? 'var(--color-tertiary)' : '#94a3b8'}
                    strokeWidth={isHoveredEdge ? width + 2 : width}
                    strokeDasharray={isCross ? '8 8' : undefined}
                    style={{ opacity, transition: 'opacity 0.2s, stroke 0.2s', pointerEvents: isMismatch ? 'stroke' : 'none', cursor: isMismatch ? 'pointer' : undefined, filter: isMismatch ? 'drop-shadow(0 0 4px #ef4444)' : undefined }}
                    role={isMismatch ? 'button' : undefined}
                    tabIndex={isMismatch ? 0 : undefined}
                    aria-label={isMismatch ? `Compare conflict: ${edge.message}` : undefined}
                    onPointerDown={e => { if (isMismatch) e.stopPropagation(); }}
                    onClick={() => { if (isMismatch) setSelectedConflict(issueForEdge(edge)); }}
                    onKeyDown={e => { if (isMismatch && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelectedConflict(issueForEdge(edge)); } }}
                    data-testid={isMismatch ? 'mismatch-edge' : undefined}
                    data-severity={isMismatch ? edge.severity : undefined}
                  />
                );
              })}
            </svg>

            {/* Nodes */}
            {nodes.map((node, i) => (
              <GraphNodeView
                key={node.id}
                node={node}
                index={i}
                isViewed={viewedNodeIds.has(node.id)}
                isHovered={hoveredId === node.id}
                isFaded={hoveredId !== null && hoveredId !== node.id && !hoveredNeighbors?.has(node.id)}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => handleNodeClick(node)}
              />
            ))}
          </motion.div>
        </motion.div>

        {/* Controls */}
        <div className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 space-y-2 z-40">
          <ControlButton icon="add" label="Zoom in" onClick={() => setZoom(z => Math.min(z * 1.25, 3))} />
          <ControlButton icon="remove" label="Zoom out" onClick={() => setZoom(z => Math.max(z / 1.25, 0.15))} />
          <div className="h-4"></div>
          <ControlButton icon={isMaximized ? 'close_fullscreen' : 'open_in_full'} label={isMaximized ? 'Exit full screen' : 'Full screen'} onClick={() => setIsMaximized(m => !m)} />
          <ControlButton icon="center_focus_strong" label="Fit to screen" onClick={resetView} />
        </div>

        {/* Legend */}
        <div className="absolute bottom-4 left-4 md:bottom-8 md:left-8 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md p-3 md:p-6 rounded-3xl border border-slate-200/50 dark:border-slate-700/50 shadow-lg space-y-1.5 md:space-y-3 z-40 pointer-events-none">
          {entities ? (
            <>
              <LegendItem color="bg-secondary" label="People & organisations" />
              <LegendItem color="bg-tertiary" label="Documents" />
              <LegendItem color="bg-slate-400" label="Fields" />
              <LegendItem color="bg-red-500" label="Values that conflict" />
            </>
          ) : (
            <>
              <LegendItem color="bg-primary" label="Core concept" />
              <LegendItem color="bg-secondary" label="Main topics" />
              <LegendItem color="bg-tertiary" label="Sub-topics" />
              <LegendItem color="bg-slate-400" label="Details" />
            </>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedNode && (
          <ConceptModal
            node={selectedNode}
            nodeById={nodeById}
            edges={edges}
            onSelect={handleNodeClick}
            onClose={() => setSelectedNode(null)}
            onOpenDocument={onOpenDocument}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

interface GraphNodeViewProps {
  node: PositionedNode;
  index: number;
  isViewed: boolean;
  isHovered: boolean;
  isFaded: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
}

const NODE_STYLES: Record<string, { box: string; label: string; caption?: string; captionClass?: string }> = {
  major: {
    box: 'w-56 min-h-28 bg-white dark:bg-slate-800 border-[3px] border-primary rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.4)] z-30 p-4',
    label: 'text-lg font-black leading-tight uppercase tracking-tight',
    caption: 'Core Concept',
    captionClass: 'text-[10px] font-bold text-primary/60 uppercase tracking-[0.2em] mt-2',
  },
  header: {
    box: 'w-48 min-h-20 bg-slate-50 dark:bg-slate-700 border-2 border-secondary rounded-2xl shadow-md z-20 px-4 py-3',
    label: 'text-xs font-black text-secondary uppercase tracking-wider leading-tight',
    caption: 'Main Topic',
    captionClass: 'text-[8px] font-bold text-slate-400 mt-1 uppercase tracking-widest',
  },
  'sub-topic': {
    box: 'w-40 min-h-14 bg-white dark:bg-slate-800 border border-tertiary rounded-xl shadow-sm z-[15] px-3 py-2',
    label: 'text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-tight',
    caption: 'Sub-Topic',
    captionClass: 'text-[7px] font-bold text-tertiary/60 mt-0.5 uppercase tracking-widest',
  },
  concept: {
    box: 'max-w-40 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-[0_2px_8px_rgba(0,0,0,0.04)] z-10 px-3 py-1.5',
    label: 'text-[10px] font-bold text-slate-600 dark:text-slate-300 tracking-tight leading-tight',
  },
};

function GraphNodeView({ node, index, isViewed, isHovered, isFaded, onMouseEnter, onMouseLeave, onClick }: GraphNodeViewProps) {
  const style = NODE_STYLES[node.type] || NODE_STYLES.concept;
  return (
    <div
      className="absolute"
      style={{ left: node.x, top: node.y, transform: 'translate(-50%, -50%)', zIndex: isHovered ? 50 : undefined }}
    >
      <motion.button
        type="button"
        data-testid="graph-node"
        className={cn(
          'flex flex-col items-center justify-center text-center cursor-pointer transition-opacity duration-200 relative',
          style.box,
          isFaded ? 'opacity-25' : 'opacity-100',
          isViewed && 'ring-2 ring-tertiary/40 ring-offset-2',
          node.severity && SEVERITY_RING[node.severity]
        )}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: isHovered ? 1.08 : 1, opacity: 1 }}
        transition={{ duration: 0.35, delay: Math.min(index * 0.015, 0.6) }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onPointerDownCapture={e => e.stopPropagation()}
        onClick={onClick}
      >
        <span className={style.label}>{node.label}</span>
        {node.severity && <span className="absolute -top-3 -left-3 w-6 h-6 rounded-full bg-red-600 text-white font-black motion-safe:animate-pulse shadow-[0_0_14px_#ef444480]" data-testid="conflict-node-badge" aria-label="Conflicting value">!</span>}
        {style.caption && <span className={style.captionClass}>{node.caption || style.caption}</span>}
        {isViewed && (
          <span className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-tertiary text-white flex items-center justify-center">
            <span className="material-symbols-outlined text-[12px]">check</span>
          </span>
        )}
      </motion.button>
    </div>
  );
}

interface ConceptModalProps {
  node: PositionedNode;
  nodeById: Map<string, PositionedNode>;
  edges: GraphEdge[];
  onSelect: (node: PositionedNode) => void;
  onClose: () => void;
  onOpenDocument?: (id: string, fieldKey: string | null) => void;
}

const TYPE_LABEL: Record<string, string> = { major: 'Core Concept', header: 'Main Topic', 'sub-topic': 'Sub-topic', concept: 'Key Detail' };

function ConceptModal({ node, nodeById, edges, onSelect, onClose, onOpenDocument }: ConceptModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Below lg the info scrolls on its own: show the top of a newly opened concept.
  const infoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    infoRef.current?.scrollTo({ top: 0 });
  }, [node.id]);

  const related = useMemo(() => {
    const seen = new Set<string>();
    const list: { node: PositionedNode; label: string }[] = [];
    for (const e of edges) {
      const otherId = e.source === node.id ? e.target : e.target === node.id ? e.source : null;
      if (!otherId || seen.has(otherId)) continue;
      const other = nodeById.get(otherId);
      if (!other) continue;
      seen.add(otherId);
      const label = other.id === node.parentId ? 'Part of' : e.label === 'contains' ? 'Includes' : e.kind === 'mismatch' ? 'Conflicts with' : e.label || 'Related';
      list.push({ node: other, label });
    }
    // Parent first, then children, then cross-links.
    const rank = (l: string) => (l === 'Conflicts with' ? -1 : l === 'Part of' ? 0 : l === 'Includes' ? 1 : 2);
    return list.sort((a, b) => rank(a.label) - rank(b.label));
  }, [node, nodeById, edges]);

  const conflicts = edges.filter(e => e.kind === 'mismatch' && (e.source === node.id || e.target === node.id));

  const miniNodes = related.slice(0, 8).map((r, i, arr) => {
    const angle = (i / arr.length) * Math.PI * 2 - Math.PI / 2;
    return { ...r, x: Math.cos(angle) * 170, y: Math.sin(angle) * 130 };
  });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-12 overflow-hidden" role="dialog" aria-modal="true" aria-label={node.label}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
        onClick={onClose}
      />

      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 30 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 30 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="relative w-full max-w-5xl bg-white dark:bg-slate-800 rounded-[32px] md:rounded-[40px] shadow-[0_32px_128px_rgba(0,0,0,0.2)] overflow-hidden flex flex-col lg:flex-row max-h-[90dvh] lg:h-[650px]"
      >
        {/* Left Side: Info (below lg its content scrolls while Close stays in view) */}
        <div className="w-full lg:w-[380px] p-6 md:p-10 flex flex-col justify-between border-r border-slate-100 bg-white dark:bg-slate-800 z-10 min-h-0 lg:overflow-y-auto">
          <div ref={infoRef} className="space-y-8 min-h-0 overflow-y-auto -mx-6 -mt-6 px-6 pt-6 md:-mx-10 md:-mt-10 md:px-10 md:pt-10 lg:m-0 lg:p-0 lg:min-h-auto lg:overflow-visible">
            <div className="space-y-3">
              <div className="w-12 h-1 bg-primary rounded-full mb-4"></div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-primary/60">{node.caption || TYPE_LABEL[node.type] || 'Concept'}</p>
              <h3 className="text-3xl md:text-4xl font-headline font-bold text-slate-900 dark:text-slate-100 leading-[1.1] break-words">{node.label}</h3>
            </div>

            <p className="text-sm text-slate-700 font-medium leading-relaxed border-l-4 border-primary/20 pl-4 py-1 break-words" data-testid="concept-desc">
              {node.desc || 'No detailed explanation is available for this concept.'}
            </p>

            {conflicts.length > 0 && (
              <div className="space-y-2" data-testid="node-conflicts">
                {conflicts.map((e, i) => (
                  <p key={i} className={cn('px-4 py-3 border rounded-2xl text-xs font-medium leading-relaxed break-words', SEVERITY_BOX[e.severity || 'error'])}>
                    {e.message}
                  </p>
                ))}
              </div>
            )}

            {node.documentId && onOpenDocument && (
              <button type="button" onClick={() => onOpenDocument(node.documentId!, node.fieldKey || null)} className="relative text-[10px] font-bold text-primary uppercase tracking-widest hover:underline max-lg:after:absolute max-lg:after:-inset-x-2 max-lg:after:-inset-y-3" data-testid="node-open-document">
                {node.fieldKey ? 'Show this field in the document →' : 'Open this document →'}
              </button>
            )}

            {related.length > 0 && (
              <div className="space-y-3">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{node.caption ? 'Connected' : 'Connected Concepts'}</p>
                <div className="grid grid-cols-1 gap-2">
                  {related.slice(0, 8).map(r => (
                    <RelatedNodeItem key={r.node.id} node={r.node} relation={r.label} onOpen={() => onSelect(r.node)} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onClose}
            className="mt-6 lg:mt-8 group px-8 py-4 bg-slate-900 text-white rounded-2xl text-xs font-bold hover:bg-primary transition-all duration-300 flex items-center justify-center gap-3 shadow-lg active:scale-95"
          >
            <span className="material-symbols-outlined text-sm transition-transform group-hover:rotate-90">close</span>
            Close
          </button>
        </div>

        {/* Right Side: Mini Graph (on top of the info on tablets tall enough to keep the info usable) */}
        <div className="hidden md:[@media(min-height:800px)]:flex lg:flex md:order-first lg:order-none shrink-0 h-[360px] lg:h-auto lg:flex-1 bg-slate-50/50 relative overflow-hidden items-center justify-center">
          <div className="absolute inset-0 opacity-[0.4]" style={{ backgroundImage: 'radial-gradient(#e2e8f0 1.5px, transparent 1.5px)', backgroundSize: '24px 24px' }}></div>

          <div className="absolute left-1/2 top-1/2 w-0 h-0">
            <svg className="absolute overflow-visible pointer-events-none" width="1" height="1" style={{ left: 0, top: 0 }}>
              {miniNodes.map((n, i) => (
                <motion.line
                  key={n.node.id}
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.1 + i * 0.06 }}
                  x1={0} y1={0} x2={n.x} y2={n.y}
                  stroke="#cbd5e1" strokeWidth="2" strokeDasharray="6 6"
                />
              ))}
            </svg>

            {miniNodes.map((n, i) => (
              <motion.button
                key={n.node.id}
                type="button"
                onClick={() => onSelect(n.node)}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.35, delay: 0.1 + i * 0.06, type: 'spring' }}
                className="absolute rounded-2xl px-4 py-2 bg-white/95 border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md hover:border-primary/40 max-w-40 max-lg:w-max"
                style={{ left: n.x, top: n.y, x: '-50%', y: '-50%' }}
              >
                <span className="block text-[9px] uppercase tracking-wider text-slate-400 font-bold">{n.label}</span>
                <span className="block text-[11px] text-slate-700 font-bold leading-tight">{n.node.label}</span>
              </motion.button>
            ))}

            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="absolute rounded-2xl px-5 py-3 bg-white dark:bg-slate-800 border-primary border-[3px] w-44 min-h-20 flex items-center justify-center shadow-xl shadow-primary/10 z-20"
              style={{ left: 0, top: 0, x: '-50%', y: '-50%' }}
            >
              <p className="font-bold text-center leading-tight text-sm text-slate-900 dark:text-slate-100">{node.label}</p>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function RelatedNodeItem({ node, relation, onOpen }: { node: GraphNode; relation: string; onOpen: () => void }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className={cn(
        'group bg-slate-50/50 rounded-2xl border border-slate-100/50 transition-all overflow-hidden',
        isOpen ? 'bg-white dark:bg-slate-800 border-primary/20 shadow-lg shadow-primary/5' : 'hover:bg-slate-50 hover:border-slate-200'
      )}
    >
      <button type="button" className="w-full flex items-center justify-between p-3 text-left" onClick={() => setIsOpen(!isOpen)}>
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn('w-2 h-2 rounded-full shrink-0', isOpen ? 'bg-primary' : 'bg-slate-300')}></div>
          <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold shrink-0">{relation}</span>
          <span className={cn('text-[11px] font-bold max-sm:line-clamp-2 max-sm:wrap-anywhere sm:truncate', isOpen ? 'text-slate-900 dark:text-slate-100' : 'text-slate-600')}>{node.label}</span>
        </div>
        <span className={cn('material-symbols-outlined text-sm transition-transform duration-300', isOpen ? 'rotate-180 text-primary' : 'text-slate-300')}>
          expand_more
        </span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-8 pb-4"
          >
            <p className="text-[11px] leading-relaxed text-slate-600 font-medium border-l-2 border-primary/20 pl-4 py-1">
              {node.desc || 'Linked concept within the document hierarchy.'}
            </p>
            <button type="button" onClick={onOpen} className="relative mt-2 ml-4 text-[10px] font-bold text-primary hover:underline max-lg:after:absolute max-lg:after:-inset-x-2 max-lg:after:-inset-y-2.5">
              Open this concept →
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ControlButton({ icon, label, onClick }: { icon: string; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-11 h-11 md:w-12 md:h-12 bg-white dark:bg-slate-800 shadow-xl border border-slate-100/50 rounded-2xl flex items-center justify-center hover:bg-slate-50 transition-all text-slate-600 hover:text-primary active:scale-95"
    >
      <span className="material-symbols-outlined text-[20px]">{icon}</span>
    </button>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 md:gap-3">
      <div className={cn('w-2.5 h-2.5 rounded-full ring-2 ring-white', color)}></div>
      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{label}</span>
    </div>
  );
}
