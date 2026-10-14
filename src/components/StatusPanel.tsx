import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { UPLOAD_STEPS, uploadStepIndex } from '../lib/upload';
import { UploadStatus } from '../types';

export function StatusPanel({ uploads }: { uploads: UploadStatus[] }) {
  const [now, setNow] = useState(Date.now);
  const running = uploads.some(u => u.status === 'uploading' || u.status === 'analyzing');
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const duration = (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const bytes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
  return (
    <div className="space-y-4">
      {uploads.map((upload) => {
        const failed = upload.status === 'failed';
        const completed = upload.status === 'completed';
        const step = uploadStepIndex(upload);
        const end = upload.finishedAt || now;
        const pages = upload.pageProgress;
        const retrying = upload.stage === 'retrying';
        return (
          <motion.div
            key={upload.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            className={cn('rounded-xl p-4 sm:p-6 border', failed ? 'bg-red-50 border-red-100' : 'bg-surface-container-low border-slate-200')}
            data-testid="upload-status-card"
          >
            <div className="flex justify-between items-start mb-4 gap-3 sm:gap-4">
              <div className="flex gap-3 sm:gap-4 min-w-0">
                <span
                  className={cn('material-symbols-outlined', failed ? 'text-red-400' : 'text-secondary')}
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {failed ? 'error' : upload.status === 'completed' ? 'check_circle' : 'description'}
                </span>
                <div className="min-w-0">
                  <h4 className="text-sm font-bold truncate">{upload.fileName}</h4>
                  <p className={cn('text-xs mt-1 break-words', failed ? 'text-red-500' : 'text-on-surface-variant')} aria-live="polite">
                    {failed ? `Failed at: ${UPLOAD_STEPS[step].title}` : upload.subtext || 'Processing...'}
                  </p>
                  {upload.warning && !failed && (
                    <p className="flex items-center gap-1 text-[10px] font-bold text-amber-600 mt-1" data-testid="upload-quality-warning">
                      <span className="material-symbols-outlined text-[12px]">warning</span>
                      {upload.warning}
                    </p>
                  )}
                </div>
              </div>
              {!failed && <span className="text-xs text-primary font-mono shrink-0">{Math.round(upload.progress)}%</span>}
            </div>
            <div className="h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden">
              <motion.div
                className={cn('h-full rounded-full', failed ? 'bg-red-300' : 'bg-gradient-to-r from-primary to-secondary')}
                initial={{ width: 0 }}
                animate={{ width: `${failed ? 100 : upload.progress}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant mt-3" data-testid="upload-step-summary">
              <span className="font-semibold">{completed ? upload.cached ? 'Ready · cached result' : '6 of 6 steps complete' : `Step ${step + 1} of 6 · ${step} complete`}</span>
              {upload.startedAt && <span>{duration(end - upload.startedAt)} elapsed</span>}
              {!failed && !completed && upload.stageStartedAt && <span>{duration(now - upload.stageStartedAt)} in this step</span>}
              {((upload.attempts || 0) > 1 || retrying) && <span className="text-amber-700">Attempt {Math.max(1, (upload.attempts || 0) + (retrying ? 1 : 0))}</span>}
            </div>
            {upload.status === 'uploading' && upload.size != null && (
              <p className="text-[11px] text-on-surface-variant mt-2">{bytes(upload.uploadBytes || 0)} / {bytes(upload.size)} sent{upload.stage === 'storing' ? ' · confirming storage' : ''}</p>
            )}
            {pages && (
              <div className="rounded-lg bg-white/70 border border-slate-200 px-3 py-2 mt-3 text-xs" data-testid="upload-page-progress">
                <div className="flex flex-wrap justify-between gap-1 font-semibold">
                  <span>{pages.pagesCompleted} / {pages.pageCount} pages completed</span>
                  {!upload.cached && pages.chunkCount > 1 && <span className="text-primary">Chunk {pages.chunkIndex} / {pages.chunkCount}</span>}
                </div>
                {!completed && !failed && <p className="text-on-surface-variant mt-1">Current pages: {pages.pageStart}–{pages.pageEnd}</p>}
                {pages.chunkCount > 1 && !upload.cached && <p className="text-[10px] text-on-surface-variant mt-1">Reading, extraction and validation repeat for each chunk. The result is saved after the last chunk.</p>}
              </div>
            )}
            <ol className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2 mt-4" aria-label={`Processing steps for ${upload.fileName}`} data-testid="upload-step-list">
              {UPLOAD_STEPS.map((item, index) => {
                const skipped = upload.cached && index >= 2 && index <= 4;
                const state = skipped ? 'skipped' : failed && index === step ? 'failed'
                  : completed || index < step ? 'done' : index === step ? 'active' : 'pending';
                return (
                  <li key={item.title} aria-current={state === 'active' ? 'step' : undefined}
                    data-step-state={state}
                    className={cn('flex items-start gap-2 rounded-lg px-2 py-2 min-w-0',
                      state === 'active' ? 'bg-primary/10 text-primary' : state === 'failed' ? 'bg-red-100 text-red-600' : state === 'done' ? 'text-emerald-700' : 'text-slate-400')}>
                    <span aria-hidden="true" className={cn('flex items-center justify-center w-5 h-5 shrink-0 rounded-full text-[10px] font-bold',
                      state === 'active' ? 'bg-primary text-white animate-pulse' : state === 'done' ? 'bg-emerald-100' : state === 'failed' ? 'bg-red-200' : 'bg-slate-100')}>
                      {state === 'done' ? '✓' : state === 'failed' ? '×' : index + 1}
                    </span>
                    <div className="min-w-0 text-[11px]">
                      <p className="font-semibold">{item.title}</p>
                      <p className="text-[10px] mt-0.5">{state === 'done' ? 'Done' : state === 'skipped' ? 'Skipped · cached result' : state === 'failed' ? 'Failed here' : state === 'active' ? retrying ? 'Retrying' : 'In progress' : 'Next'}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {!failed && !completed && <p className="text-[11px] text-on-surface-variant mt-3" data-testid="upload-current-detail">{UPLOAD_STEPS[step].detail}</p>}
            {upload.cached && <p className="text-xs text-primary mt-3">Loaded a saved analysis; AI processing was skipped.</p>}
            {upload.lastError && !completed && <p className="text-xs text-amber-700 mt-3 break-words">Previous attempt: {upload.lastError}</p>}
            {failed && <p role="alert" className="text-xs text-red-600 mt-3 break-words" data-testid="upload-stage-error">{upload.error || upload.subtext}</p>}
          </motion.div>
        );
      })}
    </div>
  );
}
