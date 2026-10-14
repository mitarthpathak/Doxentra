import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { ScrollQuiz } from './ScrollQuiz';
import { DocumentCheckSummary } from './DocumentCheckSummary';
import type { GraphData } from '../types';
import type { Screen } from '../App';

// ─── Helper: build a dynamic roadmap from graph nodes ───────────────
function buildDynamicRoadmap(data: any) {
  const nodes = data?.nodes || [];
  if (nodes.length === 0) return null;

  // Sort by importance descending, pick top major/header nodes
  const sorted = [...nodes]
    .filter((n: any) => n.label)
    .sort((a: any, b: any) => (b.importance || 5) - (a.importance || 5));

  const coreNodes = sorted.filter((n: any) => n.type === 'major' || n.type === 'core');
  const headerNodes = sorted.filter((n: any) => n.type === 'header');
  const subNodes = sorted.filter((n: any) => n.type === 'sub-topic' || n.type === 'concept');

  // Build a 4-6 item roadmap from the hierarchy
  const roadmap: any[] = [];
  
  // Step 1: Core/major topics → "completed" (foundation)
  coreNodes.slice(0, 2).forEach((n: any, i: number) => {
    roadmap.push({
      number: String(i + 1).padStart(2, '0'),
      title: n.label,
      status: 'completed',
      desc: n.desc || `Foundational concept: ${n.label}`,
    });
  });

  // Step 2: Header topics → "in-progress" (currently studying)
  headerNodes.slice(0, 2).forEach((n: any, i: number) => {
    roadmap.push({
      number: roadmap.length === 2 ? '★' : String(roadmap.length + 1).padStart(2, '0'),
      title: n.label,
      status: i === 0 ? 'in-progress' : 'locked',
      desc: n.desc || `Key topic requiring focused study.`,
    });
  });

  // Step 3: Sub-topics → "locked" (upcoming)
  subNodes.slice(0, 2).forEach((n: any) => {
    roadmap.push({
      number: String(roadmap.length + 1).padStart(2, '0'),
      title: n.label,
      status: 'locked',
      desc: n.desc || `Advanced concept to be explored.`,
    });
  });

  // Ensure at least 3 items
  if (roadmap.length < 3) return null;
  return roadmap.slice(0, 6);
}

// ─── Helper: build related modules from graph nodes ─────────────────
function buildDynamicRelatedModules(data: any) {
  const nodes = data?.nodes || [];
  if (nodes.length === 0) return null;

  const iconMap: Record<string, string> = {
    core: 'hub', major: 'category', header: 'account_tree',
    'sub-topic': 'schema', concept: 'lightbulb',
  };

  // Pick diverse nodes for "related modules"
  const picked = [...nodes]
    .filter((n: any) => n.label && n.desc)
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  return picked.map((n: any) => ({
    icon: iconMap[n.type] || 'auto_awesome',
    title: n.label,
    desc: n.desc ? (n.desc.length > 60 ? n.desc.slice(0, 57) + '…' : n.desc) : 'Extracted concept',
  }));
}

// ─── Main DetailsScreen ─────────────────────────────────────────────
export function DetailsScreen({ data, viewedNodeIds, onNavigate, masked = false, onOpenDocument }: { data: GraphData | null, viewedNodeIds: Set<string>, onNavigate: (screen: Screen) => void, masked?: boolean, onOpenDocument?: (id: string) => void }) {
  const [isRelatedMaximized, setIsRelatedMaximized] = useState(false);

  // Dynamic data from graph
  const dynamicRoadmap = useMemo(() => buildDynamicRoadmap(data), [data]);
  const dynamicModules = useMemo(() => buildDynamicRelatedModules(data), [data]);

  const metadata = useMemo(() => {
    const base = data?.metadata || {};
    return {
      title: base.title || 'Knowledge Graph',
      description: base.description || 'Your uploaded document has been analyzed and the knowledge graph is ready for exploration.',
      complexity: base.complexity || 5,
      category: base.category || 'General Study',
      roadmap: (base.roadmap?.length ? base.roadmap : null) || dynamicRoadmap || [
        { number: '01', title: 'Document Scan', status: 'completed', desc: 'Initial extraction of core content.' },
        { number: '02', title: 'Concept Mapping', status: 'in-progress', desc: 'Building relationships between entities.' },
        { number: '03', title: 'Deep Analysis', status: 'locked', desc: 'Detailed semantic understanding.' },
      ],
      relatedModules: (base.relatedModules?.length ? base.relatedModules : null) || dynamicModules || [
        { icon: 'analytics', title: 'Pattern Recognition', desc: 'Statistical distribution of key terms' },
        { icon: 'account_tree', title: 'Hierarchy Discovery', desc: 'Nested relationship identification' },
        { icon: 'hub', title: 'Semantic Links', desc: 'Cross-concept connections' },
      ],
    };
  }, [data, dynamicRoadmap, dynamicModules]);

  const scrollToQuiz = () => document.getElementById('knowledge-check')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const nodeCount = data?.nodes?.length || 0;
  const exploredCount = (data?.nodes || []).filter((n: any) => viewedNodeIds?.has(n.id)).length;
  const progressPercent = nodeCount > 0 ? Math.round((exploredCount / nodeCount) * 100) : 0;
  const filename = data?.filename || 'No document loaded';
  const hasData = !!(data && data.nodes && data.nodes.length > 0);
  const complexity = Number(metadata.complexity) || 5;

  return (
    <div className="space-y-8 md:space-y-12 py-6 md:py-8 relative">

      {/* ─── Validation and review of the source document (maps built from a document only) ── */}
      {onOpenDocument && <DocumentCheckSummary documentId={data?.id} masked={masked} onOpenDocument={onOpenDocument} />}

      {/* ─── Top Hero Card with PDF info ──────────────────────── */}
      <div className="relative md:h-64 rounded-[40px] overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-secondary/10 to-tertiary/20 transition-transform duration-700 group-hover:scale-105" />
        <div className="absolute inset-0 bg-gradient-to-br from-white/90 via-white/50 to-transparent backdrop-blur-[2px]"></div>
        <div className="relative min-h-64 md:absolute md:inset-0 p-6 sm:p-8 md:p-10 flex flex-col justify-between gap-5 md:gap-0">
          <div className="flex flex-wrap justify-between items-start gap-3">
            {/* PDF file badge */}
            <div className="flex items-center gap-3 max-lg:min-w-0 max-lg:max-w-full px-5 py-2.5 bg-white/70 backdrop-blur-md rounded-2xl border border-slate-200 shadow-sm">
              <span className="material-symbols-outlined text-primary text-lg">picture_as_pdf</span>
              <div className="max-lg:min-w-0">
                <p className="text-xs font-bold text-slate-900 truncate max-w-[200px]">{filename}</p>
                <p className="text-[9px] text-on-surface-variant">{nodeCount} concepts extracted</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 px-4 py-1.5 bg-primary/10 backdrop-blur-md rounded-full border border-primary/20">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
              <span className="text-[10px] font-black text-primary uppercase tracking-widest whitespace-nowrap">
                {hasData ? 'Live Document Map' : 'Awaiting Document'}
              </span>
            </div>
          </div>
          <div className="max-w-xl space-y-4">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-primary/10 rounded-xl shrink-0">
                <span className="material-symbols-outlined text-primary text-3xl">auto_stories</span>
              </div>
              <div className="max-lg:min-w-0">
                <h3 className="text-xl sm:text-2xl font-headline font-bold text-slate-900 max-lg:break-words">{metadata.category} Intelligence</h3>
                <p className="text-[10px] font-bold text-primary uppercase tracking-[0.12em] sm:tracking-[0.2em] max-lg:break-words">{filename}</p>
              </div>
            </div>
            <p className="text-sm text-on-surface-variant leading-relaxed font-medium">
              {hasData
                ? `We've processed ${nodeCount} semantic entities to build your personal ${metadata.title} knowledge graph.`
                : 'Upload a PDF to see your personalized knowledge breakdown here.'}
            </p>
          </div>
        </div>
      </div>

      {/* ─── Main 2-col: Roadmap | Title+Stats ────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 md:gap-12">
        {/* Left: Roadmap */}
        <div className="lg:col-span-5 space-y-8">
          <div className="flex flex-wrap lg:flex-nowrap justify-between items-end gap-x-4 gap-y-1 lg:gap-0">
            <h3 className="text-2xl sm:text-3xl font-headline font-bold">Prerequisite Roadmap</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 max-lg:whitespace-nowrap">{metadata.roadmap.length} Milestones</p>
          </div>
          <div className="relative space-y-8 md:space-y-12 pl-12 pt-4">
            <div className="absolute left-[23px] top-6 bottom-6 w-0.5 bg-gradient-to-b from-primary via-surface-container-highest to-surface-container-highest"></div>

            {metadata.roadmap.map((item: any, idx: number) => (
              <RoadmapItem
                key={idx}
                number={item.number}
                title={item.title}
                status={item.status}
                desc={item.desc}
                active={item.status === 'in-progress'}
                onStudy={() => onNavigate('graph')}
                onExercises={scrollToQuiz}
              />
            ))}
          </div>
        </div>

        {/* Right: Content */}
        <div className="lg:col-span-7 space-y-8">
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
              <span className="px-4 py-1 bg-tertiary/10 text-tertiary text-[10px] font-black uppercase rounded-full border border-tertiary/20 tracking-widest">{metadata.category}</span>
              <span className="px-4 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase rounded-full border border-primary/20 tracking-widest">
                {complexity >= 8 ? 'High Complexity' : complexity >= 5 ? 'Medium Complexity' : 'Low Complexity'}
              </span>
            </div>
            <h2 className="text-3xl min-[360px]:text-4xl sm:text-5xl md:text-7xl font-headline font-bold leading-[0.9] text-slate-900 break-words">
              {metadata.title.split(' ').length > 1 ? (
                <>
                  {metadata.title.split(' ').slice(0, -1).join(' ')} <br />
                  <span className="text-primary italic">{metadata.title.split(' ').slice(-1)}</span>
                </>
              ) : (
                <span className="text-primary italic">{metadata.title}</span>
              )}
            </h2>
            <p className="text-on-surface-variant text-lg md:text-xl leading-relaxed font-medium opacity-80">
              {metadata.description}
            </p>
          </div>

          <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3 sm:gap-4">
            <div className="bg-surface-container-low p-5 sm:p-8 rounded-[32px] border border-slate-200 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-[0.12em] sm:tracking-[0.2em] text-on-surface-variant mb-3 sm:mb-4 opacity-50">Syllabus Complexity</p>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-2xl sm:text-4xl font-headline font-bold text-primary">Level {String(complexity).padStart(2, '0')}</p>
                <p className="text-xs font-bold text-slate-400">/ 10</p>
              </div>
            </div>
            <div className="bg-surface-container-low p-5 sm:p-8 rounded-[32px] border border-slate-200 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-[0.12em] sm:tracking-[0.2em] text-on-surface-variant mb-3 sm:mb-4 opacity-50">Semantic Context</p>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-2xl sm:text-4xl font-headline font-bold text-tertiary">{nodeCount}</p>
                <p className="text-xs font-bold text-slate-400">Concepts</p>
              </div>
            </div>
          </div>

          {/* Exploration Progress */}
          <div className="bg-surface-container-low p-6 sm:p-10 rounded-[40px] border border-slate-200 shadow-sm space-y-6">
            <div className="flex justify-between items-center gap-4">
              <div className="max-lg:min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Exploration Progress</p>
                <p className="text-xl font-headline font-bold mt-1">Syllabus Mastery</p>
              </div>
              <p className="text-3xl font-headline font-bold text-primary">{progressPercent}%</p>
            </div>
            <div className="h-4 bg-surface-container-highest rounded-full overflow-hidden p-1 shadow-inner">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progressPercent}%` }}
                transition={{ duration: 1.5, ease: 'easeOut' }}
                className="h-full bg-gradient-to-r from-primary via-secondary to-tertiary rounded-full shadow-lg"
              ></motion.div>
            </div>
            <p className="text-xs text-on-surface-variant font-medium text-center">
              You have successfully explored {exploredCount} out of {nodeCount} knowledge nodes.
            </p>
          </div>
        </div>
      </div>

      {/* ─── Side-by-side: Related Modules (LEFT) + Quiz (RIGHT) ─ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* LEFT — Related Modules (collapsed card only) */}
        <div className="lg:col-span-4 lg:sticky lg:top-28">
          {!isRelatedMaximized && (
            <motion.div
              layoutId="related-container"
              className="bg-surface-container-low p-5 sm:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-4 sm:space-y-6"
            >
              <div className="flex justify-between items-center gap-3 lg:gap-0">
                <div className="flex items-center gap-3 max-lg:min-w-0">
                  <div className="p-2 bg-tertiary/10 rounded-xl shrink-0">
                    <span className="material-symbols-outlined text-tertiary text-lg">hub</span>
                  </div>
                  <h4 className="text-lg min-[360px]:text-xl font-headline font-bold">Related Modules</h4>
                </div>
                <button onClick={() => setIsRelatedMaximized(true)} className="w-9 h-9 max-lg:shrink-0 rounded-xl bg-surface-container-highest flex items-center justify-center hover:bg-primary hover:text-white transition-all">
                  <span className="material-symbols-outlined text-sm">open_in_full</span>
                </button>
              </div>
              <div className="space-y-1 sm:space-y-3">
                {metadata.relatedModules.slice(0, 5).map((mod: any, idx: number) => (
                  <RelatedModule key={idx} icon={mod.icon} title={mod.title} desc={mod.desc} />
                ))}
              </div>
            </motion.div>
          )}
        </div>

        {/* RIGHT — Knowledge Check Quiz */}
        <div className="lg:col-span-8">
          <div id="knowledge-check" className="scroll-mt-24">
            <ScrollQuiz key={data?.id || data?.filename || 'none'} data={data} />
          </div>
        </div>
      </div>

      {/* ─── Maximized Related Modules Overlay (outside grid, over everything) ─ */}
      <AnimatePresence>
        {isRelatedMaximized && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 md:p-12">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xl"
              onClick={() => setIsRelatedMaximized(false)}
            />
            <motion.div
              layoutId="related-container"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="relative w-full max-w-4xl max-h-[85dvh] md:max-h-[90vh] overflow-y-auto max-md:overscroll-contain bg-white rounded-[32px] md:rounded-[48px] p-5 sm:p-8 md:p-16 shadow-2xl space-y-6 sm:space-y-8 md:space-y-12 z-10"
            >
              <div className="flex justify-between items-center gap-4 lg:gap-0">
                <h4 className="text-2xl sm:text-3xl md:text-5xl font-headline font-bold">Extended Knowledge Domains</h4>
                <button onClick={() => setIsRelatedMaximized(false)} className="w-12 h-12 md:w-16 md:h-16 shrink-0 rounded-2xl bg-slate-900 text-white flex items-center justify-center hover:bg-primary transition-all">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-6 md:gap-8">
                {metadata.relatedModules.map((mod: any, idx: number) => (
                  <RelatedModule key={idx} icon={mod.icon} title={mod.title} desc={mod.desc} large />
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── RoadmapItem ────────────────────────────────────────────────────
function RoadmapItem({ number, title, status, desc, active = false, onStudy, onExercises }: { number: string; title: string; status: string; desc: string; active?: boolean; onStudy: () => void; onExercises: () => void }) {
  return (
    <div className="relative group">
      <div className={cn(
        'absolute -left-12 w-12 h-12 rounded-full border-2 flex items-center justify-center z-10 transition-all',
        active ? 'bg-primary border-primary shadow-[0_0_16px_rgba(8,145,178,0.3)]' : 'bg-surface-container-low border-surface-container-highest group-hover:border-primary/50'
      )}>
        <span className={cn('text-xs font-bold', active ? 'text-on-primary' : 'text-on-surface-variant')}>{number}</span>
      </div>
      <div className={cn(
        'p-5 md:p-6 rounded-3xl border transition-all',
        active ? 'bg-surface-container-high border-primary/20' : 'bg-surface-container-low border-slate-200 opacity-60'
      )}>
        <div className="flex justify-between items-start gap-2 lg:gap-0 mb-2">
          <h4 className="font-bold max-lg:min-w-0 max-lg:break-words">{title}</h4>
          <span className={cn('text-[8px] font-bold uppercase px-1.5 py-0.5 rounded max-lg:shrink-0 max-lg:whitespace-nowrap',
            status === 'completed' ? 'bg-tertiary/20 text-tertiary' :
            status === 'in-progress' ? 'bg-primary/20 text-primary' : 'bg-surface-container-highest text-on-surface-variant'
          )}>
            {String(status || '').replace('-', ' ')}
          </span>
        </div>
        <p className="text-[10px] text-on-surface-variant leading-relaxed">
          {desc}
        </p>
        {active && (
          <div className="flex gap-3 mt-4">
            <button onClick={onStudy} className="flex-1 py-3 lg:py-2 bg-primary text-on-primary text-[10px] font-bold rounded-lg hover:opacity-90">Study in Graph</button>
            <button onClick={onExercises} className="flex-1 py-3 lg:py-2 bg-surface-container-highest text-on-surface text-[10px] font-bold rounded-lg hover:bg-surface-bright">Take the Quiz</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── RelatedModule ──────────────────────────────────────────────────
function RelatedModule({ icon, title, desc, large = false }: { icon: string; title: string; desc: string; large?: boolean }) {
  return (
    <div className={cn(
      'flex gap-4 items-center rounded-2xl transition-all cursor-pointer group',
      large ? 'p-4 sm:p-6 bg-slate-50 border border-slate-100 hover:border-primary/30' : 'p-3 sm:p-4 hover:bg-surface-container-high'
    )}>
      <div className={cn(
        'bg-surface-container-highest rounded-xl flex items-center justify-center group-hover:bg-primary group-hover:text-white transition-all shrink-0',
        large ? 'w-12 h-12 sm:w-16 sm:h-16 shadow-sm' : 'w-10 h-10'
      )}>
        <span className={cn('material-symbols-outlined', large ? 'text-2xl' : 'text-sm')}>{icon}</span>
      </div>
      <div className="min-w-0">
        <h5 className={cn('font-bold transition-colors group-hover:text-primary truncate', large ? 'text-lg sm:text-xl' : 'text-sm')}>{title}</h5>
        <p className={cn('text-on-surface-variant font-medium line-clamp-2', large ? 'text-xs mt-1' : 'text-[10px]')}>{desc}</p>
      </div>
    </div>
  );
}
