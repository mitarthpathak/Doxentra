import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, useScroll, useTransform } from 'motion/react';
import { cn } from '../lib/utils';

// ─── Types ──────────────────────────────────────────────────────────
interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  correctIndex: number;
  conceptLabel: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

// ─── Helper: generate quiz questions from graph nodes ───────────────
function generateQuestionsFromGraph(data: any): QuizQuestion[] {
  const nodes = data?.nodes || [];
  if (nodes.length === 0) return getFallbackQuestions();

  const questions: QuizQuestion[] = [];

  // Filter nodes that have meaningful descriptions
  const usableNodes = nodes.filter((n: any) => n.label && n.desc && n.desc.length > 15);
  
  if (usableNodes.length < 3) return getFallbackQuestions();

  // Type 1: "What is [concept]?" — pick the correct description
  shuffle(usableNodes).slice(0, 4).forEach((node: any, idx: number) => {
    const wrongDescs = usableNodes
      .filter((n: any) => n.id !== node.id && n.desc)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map((n: any) => truncate(n.desc, 80));

    if (wrongDescs.length < 3) return;

    const correctDesc = truncate(node.desc, 80);
    if (wrongDescs.includes(correctDesc) || new Set(wrongDescs).size < 3) return;
    const options = shuffle([correctDesc, ...wrongDescs]);

    questions.push({
      id: questions.length,
      question: `What best describes "${node.label}"?`,
      options,
      correctIndex: options.indexOf(correctDesc),
      conceptLabel: node.label,
      difficulty: idx < 2 ? 'easy' : 'medium',
    });
  });

  // Type 2: "Which concept belongs to [type]?" 
  const typeGroups: Record<string, any[]> = {};
  usableNodes.forEach((n: any) => {
    const t = n.type || 'concept';
    if (!typeGroups[t]) typeGroups[t] = [];
    typeGroups[t].push(n);
  });

  Object.entries(typeGroups).slice(0, 2).forEach(([type, group], idx) => {
    if (group.length < 1 || usableNodes.length < 4) return;
    const correct = group[0];
    const wrongs = usableNodes
      .filter((n: any) => (n.type || 'concept') !== type)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    if (wrongs.length < 3) return;

    const wrongLabels = [...new Set<string>(wrongs.map((w: any) => w.label))].filter(l => l !== correct.label);
    if (wrongLabels.length < 3) return;
    const options = shuffle([correct.label, ...wrongLabels]);
    questions.push({
      id: questions.length,
      question: `Which of these is classified as a "${formatType(type)}" concept?`,
      options,
      correctIndex: options.indexOf(correct.label),
      conceptLabel: correct.label,
      difficulty: 'hard',
    });
  });

  // Ensure at least 3 questions
  if (questions.length < 3) {
    const extra = getFallbackQuestions().slice(0, 3 - questions.length);
    return [...questions, ...extra].map((q, i) => ({ ...q, id: i }));
  }

  return questions.slice(0, 6);
}

function formatType(type: string): string {
  return type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function truncate(str: string, len: number): string {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trim() + '…' : str;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getFallbackQuestions(): QuizQuestion[] {
  return [
    {
      id: 0, question: 'What is the primary purpose of a knowledge graph?',
      options: ['Organizing semantic relationships between concepts', 'Storing large binary files', 'Rendering 3D graphics', 'Compiling source code'],
      correctIndex: 0, conceptLabel: 'Knowledge Graph', difficulty: 'easy',
    },
    {
      id: 1, question: 'Which technique is used for extracting entities from text?',
      options: ['Gradient Descent', 'Named Entity Recognition (NER)', 'Binary Search', 'Fourier Transform'],
      correctIndex: 1, conceptLabel: 'NER', difficulty: 'medium',
    },
    {
      id: 2, question: 'What does "semantic similarity" measure?',
      options: ['File size comparison', 'Network latency', 'Meaning closeness between concepts', 'Pixel color difference'],
      correctIndex: 2, conceptLabel: 'Semantics', difficulty: 'easy',
    },
    {
      id: 3, question: 'In a mind-map, what is the root node?',
      options: ['A leaf concept', 'The central/main topic', 'An edge label', 'A file extension'],
      correctIndex: 1, conceptLabel: 'Mind Map', difficulty: 'medium',
    },
  ];
}

// ─── Particle Burst Component ───────────────────────────────────────
function ParticleBurst({ trigger }: { trigger: number }) {
  const particles = useMemo(() => 
    Array.from({ length: 18 }, (_, i) => ({
      id: i,
      angle: (i / 18) * 360,
      distance: 60 + Math.random() * 80,
      size: 3 + Math.random() * 5,
      delay: Math.random() * 0.15,
      color: ['#0891b2', '#7c3aed', '#059669', '#f59e0b', '#ec4899'][i % 5],
    })), [trigger]);

  return (
    <AnimatePresence>
      {trigger > 0 && particles.map(p => (
        <motion.div
          key={`${trigger}-${p.id}`}
          className="absolute rounded-full pointer-events-none"
          style={{
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            left: '50%',
            top: '50%',
          }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{
            x: Math.cos((p.angle * Math.PI) / 180) * p.distance,
            y: Math.sin((p.angle * Math.PI) / 180) * p.distance,
            opacity: 0,
            scale: 0,
          }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, delay: p.delay, ease: 'easeOut' }}
        />
      ))}
    </AnimatePresence>
  );
}

// ─── Single Question Card ───────────────────────────────────────────
function QuestionCard({
  question,
  index,
  total,
  onAnswer,
  selectedAnswer,
  isRevealed,
}: {
  question: QuizQuestion;
  index: number;
  total: number;
  onAnswer: (optIdx: number) => void;
  selectedAnswer: number | null;
  isRevealed: boolean;
}) {
  const [burstCount, setBurstCount] = useState(0);
  const difficultyConfig = {
    easy: { label: 'EASY', color: 'text-tertiary', bg: 'bg-tertiary/10', border: 'border-tertiary/20', glow: 'shadow-tertiary/10' },
    medium: { label: 'MEDIUM', color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/20', glow: 'shadow-primary/10' },
    hard: { label: 'HARD', color: 'text-secondary', bg: 'bg-secondary/10', border: 'border-secondary/20', glow: 'shadow-secondary/10' },
  };
  const dc = difficultyConfig[question.difficulty];

  const handleOptionClick = (optIdx: number) => {
    if (isRevealed) return;
    onAnswer(optIdx);
    if (optIdx === question.correctIndex) {
      setBurstCount(prev => prev + 1);
    }
  };

  return (
    <motion.div
      className="w-full"
      initial={{ opacity: 0, y: 60, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -60, scale: 0.92 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Question number & difficulty */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 mb-6 sm:flex sm:justify-between sm:gap-3 sm:mb-8">
        <div className="contents sm:flex sm:items-center sm:gap-4 sm:max-lg:min-w-0">
          <div className="relative shrink-0 row-span-2">
            <motion.div
              className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center shadow-lg"
              animate={{ rotate: [0, 3, -3, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <span className="text-white font-headline font-bold text-lg sm:text-xl">
                {String(index + 1).padStart(2, '0')}
              </span>
            </motion.div>
            {/* Ping ring */}
            <motion.div
              className="absolute inset-0 rounded-2xl border-2 border-primary/40"
              animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          </div>
          <div className="max-lg:min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.15em] sm:tracking-[0.25em] text-on-surface-variant opacity-40">
              Question {index + 1} of {total}
            </p>
            <p className="text-sm font-bold text-on-surface-variant opacity-60 mt-0.5 max-lg:break-words">
              Concept: <span className="text-primary">{question.conceptLabel}</span>
            </p>
          </div>
        </div>
        <span className={cn('justify-self-start px-4 py-1.5 max-lg:shrink-0 rounded-full text-[10px] font-black uppercase tracking-widest border', dc.bg, dc.color, dc.border)}>
          {dc.label}
        </span>
      </div>

      {/* Question text */}
      <motion.h3
        className="text-xl sm:text-2xl md:text-3xl font-headline font-bold text-slate-900 dark:text-slate-100 leading-snug mb-6 sm:mb-10 max-lg:break-words"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.15, duration: 0.5 }}
      >
        {question.question}
      </motion.h3>

      {/* Options Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 relative">
        <ParticleBurst trigger={burstCount} />
        {question.options.map((opt, optIdx) => {
          const isSelected = selectedAnswer === optIdx;
          const isCorrect = optIdx === question.correctIndex;
          const showCorrect = isRevealed && isCorrect;
          const showWrong = isRevealed && isSelected && !isCorrect;

          return (
            <motion.button
              key={optIdx}
              onClick={() => handleOptionClick(optIdx)}
              disabled={isRevealed}
              className={cn(
                'relative text-left p-4 sm:p-5 rounded-2xl border-2 transition-all duration-300 group overflow-hidden',
                !isRevealed && !isSelected && 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-primary/40 hover:shadow-md hover:shadow-primary/5',
                !isRevealed && isSelected && 'border-primary bg-primary/5 shadow-md shadow-primary/10',
                showCorrect && 'border-tertiary bg-tertiary/5 shadow-md shadow-tertiary/10',
                showWrong && 'border-red-400 bg-red-50 dark:bg-red-950/40 shadow-md shadow-red-100',
                isRevealed && !isSelected && !isCorrect && 'opacity-40 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800',
              )}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + optIdx * 0.08, duration: 0.4 }}
              whileHover={!isRevealed ? { scale: 1.02, y: -2 } : undefined}
              whileTap={!isRevealed ? { scale: 0.98 } : undefined}
            >
              {/* Hover shimmer */}
              {!isRevealed && (
                <motion.div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"
                />
              )}

              <div className="flex items-start gap-3 sm:gap-4 relative z-10">
                <div className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-sm font-bold transition-all duration-300',
                  !isRevealed && !isSelected && 'bg-slate-100 dark:bg-slate-700 text-slate-500 group-hover:bg-primary/10 group-hover:text-primary',
                  !isRevealed && isSelected && 'bg-primary text-white',
                  showCorrect && 'bg-tertiary text-white',
                  showWrong && 'bg-red-400 text-white',
                )}>
                  {showCorrect ? (
                    <motion.span
                      className="material-symbols-outlined text-base"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                    >check</motion.span>
                  ) : showWrong ? (
                    <motion.span
                      className="material-symbols-outlined text-base"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                    >close</motion.span>
                  ) : (
                    String.fromCharCode(65 + optIdx) // A, B, C, D
                  )}
                </div>
                <p className={cn(
                  'max-lg:min-w-0 max-lg:break-words text-sm font-medium leading-relaxed pt-1.5 transition-colors',
                  showCorrect && 'text-tertiary font-semibold',
                  showWrong && 'text-red-500 dark:text-red-300 line-through',
                  !isRevealed && 'text-slate-700',
                )}>
                  {opt}
                </p>
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Feedback message */}
      <AnimatePresence>
        {isRevealed && (
          <motion.div
            className={cn(
              'mt-6 p-4 sm:p-5 rounded-2xl flex items-center gap-3 sm:gap-4',
              selectedAnswer === question.correctIndex
                ? 'bg-tertiary/10 border border-tertiary/20'
                : 'bg-red-50 dark:bg-red-950/40 border border-red-200',
            )}
            initial={{ opacity: 0, y: 20, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            <span className={cn(
              'material-symbols-outlined text-2xl max-lg:shrink-0',
              selectedAnswer === question.correctIndex ? 'text-tertiary' : 'text-red-400',
            )}>
              {selectedAnswer === question.correctIndex ? 'emoji_events' : 'lightbulb'}
            </span>
            <p className={cn(
              'max-lg:min-w-0 max-lg:break-words text-sm font-medium',
              selectedAnswer === question.correctIndex ? 'text-tertiary' : 'text-red-600 dark:text-red-300',
            )}>
              {selectedAnswer === question.correctIndex
                ? 'Brilliant! You nailed it. Keep the momentum going!'
                : `Not quite — the correct answer is "${question.options[question.correctIndex]}".`}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Progress Dots ──────────────────────────────────────────────────
function ProgressDots({
  total,
  current,
  answers,
  questions,
  onDotClick,
}: {
  total: number;
  current: number;
  answers: (number | null)[];
  questions: QuizQuestion[];
  onDotClick: (idx: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => {
        const answered = answers[i] !== null && answers[i] !== undefined;
        const correct = answered && answers[i] === questions[i]?.correctIndex;
        const wrong = answered && answers[i] !== questions[i]?.correctIndex;
        const isCurrent = i === current;

        return (
          <motion.button
            key={i}
            onClick={() => onDotClick(i)}
            className={cn(
              'relative rounded-full transition-all duration-300 cursor-pointer max-lg:before:absolute max-lg:before:-inset-x-1 max-lg:before:-inset-y-3',
              isCurrent ? 'w-10 h-4' : 'w-4 h-4',
              !answered && !isCurrent && 'bg-slate-200 hover:bg-slate-300',
              !answered && isCurrent && 'bg-gradient-to-r from-primary to-secondary',
              correct && 'bg-tertiary',
              wrong && 'bg-red-400',
            )}
            whileHover={{ scale: 1.2 }}
            whileTap={{ scale: 0.9 }}
            layout
          >
            {isCurrent && (
              <motion.div
                className="absolute inset-0 rounded-full border-2 border-primary/30"
                animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0, 0.4] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              />
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

// ─── Main ScrollQuiz Component ──────────────────────────────────────
export function ScrollQuiz({ data }: { data: any }) {
  const questions = useMemo(() => generateQuestionsFromGraph(data), [data]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(() => new Array(questions.length).fill(null));
  const [revealed, setRevealed] = useState<boolean[]>(() => new Array(questions.length).fill(false));
  const [isCompleted, setIsCompleted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start end', 'end start'] });

  const parallaxY = useTransform(scrollYProgress, [0, 1], [40, -40]);

  // Phones: the card is taller than the screen, so after Next/Finish (tapped at its
  // bottom) bring the top of the new question or the result back into view. Not
  // smooth: motion restores the scroll position while it measures height: 'auto'.
  const shown = useRef({ currentIndex, isCompleted });
  useEffect(() => {
    if (shown.current.currentIndex === currentIndex && shown.current.isCompleted === isCompleted) return;
    shown.current = { currentIndex, isCompleted };
    const card = cardRef.current;
    if (!card || !window.matchMedia('(max-width: 767px)').matches) return;
    const top = card.getBoundingClientRect().top;
    if (top < 80) window.scrollTo({ top: window.scrollY + top - 80, behavior: 'instant' });
  }, [currentIndex, isCompleted]);

  const handleAnswer = useCallback((optIdx: number) => {
    setAnswers(prev => {
      const n = [...prev];
      n[currentIndex] = optIdx;
      return n;
    });
    setRevealed(prev => {
      const n = [...prev];
      n[currentIndex] = true;
      return n;
    });
  }, [currentIndex]);

  const goNext = useCallback(() => {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      setIsCompleted(true);
    }
  }, [currentIndex, questions.length]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  }, [currentIndex]);

  const resetQuiz = useCallback(() => {
    setCurrentIndex(0);
    setAnswers(new Array(questions.length).fill(null));
    setRevealed(new Array(questions.length).fill(false));
    setIsCompleted(false);
  }, [questions.length]);

  const score = answers.reduce<number>((acc, ans, idx) => {
    if (ans !== null && ans === questions[idx]?.correctIndex) return acc + 1;
    return acc;
  }, 0);

  const scorePercent = questions.length > 0 ? Math.round((score / questions.length) * 100) : 0;

  return (
    <div ref={containerRef} className="relative">
      {/* Section Header */}
      <motion.div
        className="mb-14 lg:mb-10"
        style={{ y: parallaxY }}
      >
        <div className="flex items-center gap-3 sm:gap-4 mb-4">
          <div className="p-3 bg-gradient-to-br from-secondary/20 to-primary/20 rounded-2xl shrink-0">
            <span className="material-symbols-outlined text-secondary text-2xl">quiz</span>
          </div>
          <div className="max-lg:min-w-0">
            <h3 className="text-2xl sm:text-3xl font-headline font-bold text-slate-900 dark:text-slate-100">Knowledge Check</h3>
            <p className="text-[10px] font-black uppercase tracking-[0.15em] sm:tracking-[0.25em] text-on-surface-variant opacity-50 mt-1">
              Scroll-driven assessment • {questions.length} Questions
            </p>
          </div>
        </div>
      </motion.div>

      {/* Quiz Container */}
      <div ref={cardRef} className="relative bg-surface-container-low rounded-[40px] border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        {/* Decorative background blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <motion.div
            className="absolute -top-20 -right-20 w-60 h-60 bg-primary/5 rounded-full blur-3xl"
            animate={{ x: [0, 20, 0], y: [0, -10, 0] }}
            transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute -bottom-20 -left-20 w-60 h-60 bg-secondary/5 rounded-full blur-3xl"
            animate={{ x: [0, -20, 0], y: [0, 10, 0] }}
            transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-40 bg-tertiary/3 rounded-full blur-3xl"
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>

        {/* Top strip — progress and controls */}
        <div className="relative z-10 px-5 sm:px-10 pt-6 sm:pt-8 pb-4 flex items-center justify-between gap-3 border-b border-slate-100">
          <ProgressDots
            total={questions.length}
            current={currentIndex}
            answers={answers}
            questions={questions}
            onDotClick={setCurrentIndex}
          />
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 px-4 py-2 bg-tertiary/10 rounded-full">
              <span className="material-symbols-outlined text-tertiary text-sm">emoji_events</span>
              <span className="text-xs font-bold text-tertiary">{score}/{questions.length}</span>
            </div>
          </div>
        </div>

        {/* Main question area */}
        <div className="relative z-10 p-5 sm:p-10 min-h-[480px]">
          <AnimatePresence mode="wait">
            {!isCompleted ? (
              <QuestionCard
                key={currentIndex}
                question={questions[currentIndex]}
                index={currentIndex}
                total={questions.length}
                onAnswer={handleAnswer}
                selectedAnswer={answers[currentIndex]}
                isRevealed={revealed[currentIndex]}
              />
            ) : (
              /* Completion Screen */
              <motion.div
                key="complete"
                className="flex flex-col items-center justify-center text-center py-8"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              >
                {/* Animated score ring */}
                <div className="relative w-40 h-40 mb-8">
                  <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="50" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                    <motion.circle
                      cx="60" cy="60" r="50" fill="none"
                      stroke="url(#scoreGradient)" strokeWidth="8"
                      strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 50}
                      initial={{ strokeDashoffset: 2 * Math.PI * 50 }}
                      animate={{ strokeDashoffset: 2 * Math.PI * 50 * (1 - scorePercent / 100) }}
                      transition={{ duration: 1.5, delay: 0.3, ease: 'easeOut' }}
                    />
                    <defs>
                      <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#0891b2" />
                        <stop offset="50%" stopColor="#7c3aed" />
                        <stop offset="100%" stopColor="#059669" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <motion.span
                      className="text-4xl font-headline font-bold text-slate-900 dark:text-slate-100"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.8 }}
                    >
                      {scorePercent}%
                    </motion.span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant opacity-50">Score</span>
                  </div>
                </div>

                <motion.h3
                  className="text-2xl sm:text-3xl font-headline font-bold text-slate-900 dark:text-slate-100 mb-3"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                >
                  {scorePercent >= 80 ? '🎉 Outstanding!' : scorePercent >= 50 ? '👏 Well Done!' : '💪 Keep Practicing!'}
                </motion.h3>
                <motion.p
                  className="text-on-surface-variant font-medium mb-8 max-w-md"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.7 }}
                >
                  You answered {score} out of {questions.length} questions correctly.
                  {scorePercent >= 80 ? ' Your mastery of this topic is impressive!' :
                    scorePercent >= 50 ? ' You have a solid foundation. Review the missed concepts.' :
                      ' Revisit the knowledge graph to deepen your understanding.'}
                </motion.p>

                <motion.div
                  className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.9 }}
                >
                  <button
                    onClick={resetQuiz}
                    className="px-8 py-3 bg-gradient-to-r from-primary to-secondary text-white font-bold rounded-2xl shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300 hover:scale-105 flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-base">replay</span>
                    Retry Quiz
                  </button>
                  <button
                    onClick={() => {
                      setIsCompleted(false);
                      setCurrentIndex(0);
                    }}
                    className="px-8 py-3 bg-surface-container-highest text-on-surface font-bold rounded-2xl hover:bg-slate-200 transition-all duration-300 flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-base">visibility</span>
                    Review Answers
                  </button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom navigation bar */}
        {!isCompleted && (
          <div className="relative z-10 px-5 sm:px-10 pb-6 sm:pb-8 pt-4 flex flex-wrap items-center justify-between gap-y-3 border-t border-slate-100">
            <button
              onClick={goPrev}
              disabled={currentIndex === 0}
              className={cn(
                'flex items-center gap-2 px-4 sm:px-6 py-3 rounded-2xl font-bold text-sm transition-all duration-300',
                currentIndex === 0
                  ? 'opacity-30 cursor-not-allowed bg-slate-100 dark:bg-slate-700 text-slate-400'
                  : 'bg-surface-container-highest text-on-surface hover:bg-slate-200 hover:scale-105',
              )}
            >
              <span className="material-symbols-outlined text-base">arrow_back</span>
              Previous
            </button>

            {/* Scroll hint */}
            <motion.div
              className="flex flex-col items-center gap-1 opacity-40 order-last basis-full sm:order-none sm:basis-auto"
              animate={{ y: [0, 4, 0] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <span className="material-symbols-outlined text-sm text-on-surface-variant">swipe_up</span>
              <span className="text-[8px] font-bold uppercase tracking-widest text-on-surface-variant">Scroll or Click</span>
            </motion.div>

            <button
              onClick={goNext}
              disabled={!revealed[currentIndex]}
              className={cn(
                'flex items-center gap-2 px-4 sm:px-6 py-3 rounded-2xl font-bold text-sm transition-all duration-300',
                !revealed[currentIndex]
                  ? 'opacity-30 cursor-not-allowed bg-slate-100 dark:bg-slate-700 text-slate-400'
                  : 'bg-gradient-to-r from-primary to-secondary text-white shadow-lg shadow-primary/20 hover:shadow-xl hover:scale-105',
              )}
            >
              {currentIndex === questions.length - 1 ? 'Finish' : 'Next'}
              <span className="material-symbols-outlined text-base">
                {currentIndex === questions.length - 1 ? 'flag' : 'arrow_forward'}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
