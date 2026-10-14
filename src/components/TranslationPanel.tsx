import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import type { DocumentResult, DocumentTranslation } from '../types';

const DEVANAGARI = /[ऀ-ॿ]/;

/** The language to translate into: English for a document with Hindi text, else Hindi. */
export function targetLanguage(doc: DocumentResult): 'en' | 'hi' {
  const hindi = /\bhi\b/.test(doc.language || '') || DEVANAGARI.test(doc.title || '') || doc.fields.some(f => f.transliteration);
  return hindi ? 'en' : 'hi';
}

export const LANGUAGE_NAMES = { en: 'English', hi: 'Hindi' } as const;

/** Ask the server for a translation (kept on the document after the first time). */
export async function fetchTranslation(doc: DocumentResult, to: 'en' | 'hi') {
  const r = await apiFetch<{ translation: DocumentTranslation }>(`/documents/${encodeURIComponent(doc.id)}/translate`, {
    method: 'POST',
    body: JSON.stringify({ to }),
  });
  return r.translation;
}

/** The translated title, summary, fields and page text, below the summary. */
export function TranslationPanel({ translation, onClose }: { translation: DocumentTranslation; onClose: () => void }) {
  const [openPage, setOpenPage] = useState<number | null>(translation.pages[0]?.page ?? null);
  const language = LANGUAGE_NAMES[translation.language];
  const ref = useRef<HTMLDivElement>(null);
  // Below lg it opens far under the Translate button: bring it into view.
  useEffect(() => {
    const el = ref.current;
    if (el && window.matchMedia('(width < 64rem)').matches && el.getBoundingClientRect().top > window.innerHeight * 0.6) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);
  return (
    <div ref={ref} className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-5 scroll-mt-24" data-testid="translation-panel" lang={translation.language}>
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">{language} translation</p>
          <p className="text-xl font-headline font-bold mt-1 break-words">{translation.title}</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close translation"
          className="w-9 h-9 rounded-xl bg-surface-container-highest flex items-center justify-center hover:bg-primary hover:text-white transition-all shrink-0"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
      <span
        className={cn(
          'inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border',
          translation.method === 'ai' ? 'bg-tertiary/10 text-tertiary border-tertiary/20' : 'bg-amber-50 text-amber-600 border-amber-100'
        )}
        data-testid="translation-method"
      >
        {translation.method === 'ai' ? 'AI translation' : 'Transliteration only: the AI is unavailable'}
      </span>
      <p className="text-on-surface leading-relaxed font-medium">{translation.summary}</p>
      {translation.fields.length > 0 && (
        <ul className="space-y-2" aria-label="Translated fields">
          {translation.fields.map(f => (
            <li key={f.key} className="px-4 py-3 bg-white rounded-2xl border border-slate-200">
              <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">{f.label}</p>
              <p className="text-sm font-medium break-words">{f.value}</p>
              <p className="text-[10px] text-on-surface-variant break-words mt-0.5">{f.original}</p>
            </li>
          ))}
        </ul>
      )}
      {translation.pages.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Translated pages">
            {translation.pages.map(p => (
              <button
                key={p.page}
                role="tab"
                aria-selected={openPage === p.page}
                onClick={() => setOpenPage(openPage === p.page ? null : p.page)}
                className={cn(
                  'px-3 py-3 lg:py-1.5 rounded-full text-[10px] font-bold uppercase transition-colors',
                  openPage === p.page ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'
                )}
              >
                Page {p.page} text
              </button>
            ))}
          </div>
          {translation.pages.filter(p => p.page === openPage).map(p => (
            <p key={p.page} className="text-sm text-on-surface leading-relaxed whitespace-pre-line bg-white rounded-2xl border border-slate-200 px-4 py-3 max-h-80 overflow-y-auto" data-testid="translation-page">
              {p.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
