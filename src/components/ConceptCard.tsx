import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import { Concept, ConceptCategory } from '../types';

// Full class names so Tailwind can see them at build time.
const STYLES: Record<ConceptCategory, { border: string; text: string; tag: string; icon: string }> = {
  'Core Concept': { border: 'border-primary', text: 'text-primary', tag: 'text-primary/80 border-primary/10', icon: 'hub' },
  'Main Topic': { border: 'border-secondary', text: 'text-secondary', tag: 'text-secondary/80 border-secondary/10', icon: 'account_tree' },
  'Sub-topic': { border: 'border-tertiary', text: 'text-tertiary', tag: 'text-tertiary/80 border-tertiary/10', icon: 'schema' },
  'Key Detail': { border: 'border-slate-400', text: 'text-slate-500', tag: 'text-slate-500 border-slate-200', icon: 'lightbulb' },
};

export function ConceptCard({ concept }: { concept: Concept }) {
  const style = STYLES[concept.category] || STYLES['Key Detail'];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        'bg-surface-container-high p-5 rounded-xl border-l-4 hover:bg-surface-bright transition-colors cursor-default group',
        style.border,
        concept.category === 'Core Concept' && 'md:col-span-2',
      )}
    >
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2">
          <span className={cn('text-[10px] font-bold uppercase tracking-widest', style.text)}>
            {concept.category}
          </span>
          {concept.isNew && (
            <span className="bg-tertiary text-on-tertiary text-[8px] font-bold px-1.5 py-0.5 rounded">NEW</span>
          )}
        </div>
        <span className={cn('material-symbols-outlined text-sm', style.text)}>{style.icon}</span>
      </div>
      <h4 className="text-xl font-headline font-bold mb-2">{concept.title}</h4>
      <p className="text-sm text-on-surface-variant leading-relaxed">{concept.description}</p>

      {concept.correlationNote && (
        <p className="mt-4 text-[10px] text-on-surface-variant italic">{concept.correlationNote}</p>
      )}

      {concept.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {concept.tags.map(tag => (
            <span key={tag} className={cn('px-2 py-0.5 rounded bg-surface-container-lowest text-[9px] border', style.tag)}>
              {tag.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}
