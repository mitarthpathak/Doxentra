/**
 * Work that continues after the response has been sent.
 *
 * On Vercel the function may be frozen once the response is sent unless the
 * work is registered with the request context's waitUntil (what
 * @vercel/functions does under the hood). Locally the promise simply keeps
 * running. Either way the job queue is self-healing: an item whose worker died
 * is leased again by the next poll (see jobs.js).
 */
const pending = new Set();

export function runInBackground(promise) {
  const p = Promise.resolve(promise).catch(err => console.error('[Background] task failed:', err));
  pending.add(p);
  p.finally(() => pending.delete(p));
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    ctx?.waitUntil?.(p);
  } catch {
    /* not on Vercel */
  }
  return p;
}

/** Tests only: wait for all background work to finish. */
export async function settleBackground() {
  while (pending.size) await Promise.all([...pending]);
}
