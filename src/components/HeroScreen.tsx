import { useLayoutEffect, useRef } from 'react';
import { motion } from 'motion/react';

/**
 * A word in the brand gradient whose letters flip in one by one.
 * Chrome leaves a child that is being moved or faded out of its parent's
 * `background-clip: text`, so a gradient on the word would hide each letter until
 * its animation ends. Instead every letter carries its own slice of one gradient:
 * --w (word width) and --o (letter offset) line the slices up (see .gradient-letter).
 */
function GradientLetters({ text, delay }: { text: string; delay: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const word = ref.current;
    if (!word) return;
    // offsetLeft/offsetWidth ignore transforms, so letters in flight measure at rest.
    const measure = () => {
      word.style.setProperty('--w', `${word.offsetWidth}px`);
      for (const letter of Array.from(word.children) as HTMLElement[]) letter.style.setProperty('--o', `${letter.offsetLeft}px`);
    };
    measure();
    // Font loading and breakpoints change the letter widths.
    const observer = new ResizeObserver(measure);
    observer.observe(word);
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={ref} className="relative inline-block drop-shadow-sm">
      {text.split('').map((char, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 50, rotateX: -90 }}
          animate={{ opacity: 1, y: 0, rotateX: 0 }}
          transition={{ delay: delay + i * 0.04, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="gradient-letter inline-block bg-gradient-to-r from-primary via-secondary to-tertiary bg-clip-text text-transparent"
          style={{ display: char === ' ' ? 'inline' : 'inline-block' }}
        >
          {char === ' ' ? ' ' : char}
        </motion.span>
      ))}
    </span>
  );
}

// Entrance timeline (seconds): the heading letter by letter, then its underline,
// then the copy below it from top to bottom.
const HIGHLIGHT = 'Hidden Links';
const HIGHLIGHT_START = 0.4;
const HIGHLIGHT_END = HIGHLIGHT_START + (HIGHLIGHT.length - 1) * 0.04 + 0.6;

interface HeroScreenProps {
  onStartJourney: () => void;
  onOpenSaved: () => void;
  isSignedIn: boolean;
}

export function HeroScreen({ onStartJourney, onOpenSaved, isSignedIn }: HeroScreenProps) {
  return (
    <div className="flex flex-col items-center text-center space-y-10 sm:space-y-12 py-8 sm:py-12">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="px-4 py-1.5 bg-primary/10 border border-primary/20 rounded-full flex items-center gap-2"
      >
        <span className="material-symbols-outlined text-xs text-primary">auto_awesome</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Intelligent Graphing Engine</span>
      </motion.div>

      <div className="space-y-8 max-w-3xl">
        <motion.h2 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="text-[2.75rem] min-[360px]:text-[3.25rem] sm:text-[5.5rem] md:text-[7rem] font-headline font-bold leading-[0.85] tracking-tight cursor-default group"
        >
          <motion.span
            className="inline-block"
            whileHover={{ scale: 1.03 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          >
            {'Uncover the'.split('').map((char, i) => (
              <motion.span
                key={i}
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.025, duration: 0.5 }}
                className="inline-block hover:text-primary transition-colors duration-200"
                style={{ display: char === ' ' ? 'inline' : 'inline-block' }}
              >
                {char === ' ' ? '\u00A0' : char}
              </motion.span>
            ))}
          </motion.span>
          <br />
          <motion.span
            className="relative inline-block"
            whileHover={{ scale: 1.05 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          >
            <GradientLetters text={HIGHLIGHT} delay={HIGHLIGHT_START} />
            {/* Shimmer sweep overlay, once the letters have landed, kept on the word */}
            <span className="absolute inset-0 overflow-hidden pointer-events-none">
              <motion.span
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                initial={{ x: '-100%' }}
                animate={{ x: ['-100%', '200%'] }}
                transition={{ delay: HIGHLIGHT_END + 0.6, duration: 3, repeat: Infinity, repeatDelay: 4, ease: 'easeInOut' }}
              />
            </span>
            {/* Underline glow */}
            <motion.span
              className="absolute -bottom-2 left-0 h-1.5 bg-gradient-to-r from-primary via-secondary to-tertiary rounded-full"
              initial={{ width: 0 }}
              animate={{ width: '100%' }}
              transition={{ delay: HIGHLIGHT_END - 0.2, duration: 0.8, ease: 'easeOut' }}
            />
          </motion.span>
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.6 }}
          className="text-on-surface-variant text-lg sm:text-xl leading-relaxed max-w-xl"
        >
          Transform fragmented data into a cohesive ecosystem. Our AI-driven engine maps relationships across disciplines, turning noise into a high-fidelity knowledge graph.
        </motion.p>
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.0, duration: 0.6 }}
        className="flex flex-col gap-4 w-full max-w-xs"
      >
        <button onClick={onStartJourney} className="bg-primary text-on-primary font-bold py-4 rounded-xl flex items-center justify-center gap-2 hover:opacity-90 transition-opacity shadow-[0_4px_16px_rgba(8,145,178,0.25)]">
          Start Your Journey <span className="material-symbols-outlined">arrow_forward</span>
        </button>
        <button onClick={onOpenSaved} className="bg-surface-container-high text-on-surface font-bold py-4 rounded-xl hover:bg-surface-bright transition-colors">
          {isSignedIn ? 'Open Saved Maps' : 'Sign In to Save Maps'}
        </button>
      </motion.div>

      {/* Compact feature highlights — no blank/loading content */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.2, duration: 0.6 }}
        className="flex flex-wrap justify-center gap-4 mt-8"
      >
        {[
          { icon: 'hub', label: 'Graph Synthesis', value: 'AI-Powered' },
          { icon: 'bolt', label: 'Powered by', value: 'Gemini AI' },
          { icon: 'quiz', label: 'Self Test', value: 'Quizzes' },
        ].map((feat, i) => (
          <motion.div
            key={i}
            whileHover={{ scale: 1.05, y: -3 }}
            className="flex items-center gap-3 px-6 py-3 bg-surface-container-low rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-default"
          >
            <span className="material-symbols-outlined text-primary text-lg">{feat.icon}</span>
            <div>
              <p className="text-xs font-bold text-slate-900 dark:text-slate-100">{feat.value}</p>
              <p className="text-[9px] text-on-surface-variant uppercase tracking-widest">{feat.label}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
