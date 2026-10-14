import { useSyncExternalStore } from 'react';
export type ProcessingMode = 'deep' | 'privacy';
export const getProcessingMode = (): ProcessingMode => {
  try { return localStorage.getItem('doxentra_processing_mode') === 'privacy' ? 'privacy' : 'deep'; } catch { return 'deep'; }
};
let busy = false;
const listeners = new Set<() => void>();
export const setProcessingBusy = (value: boolean) => { busy = value; listeners.forEach(fn => fn()); };
export const useProcessingBusy = () => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => busy);
export function switchProcessingMode() {
  if (busy) return;
  const mode = getProcessingMode() === 'privacy' ? 'deep' : 'privacy';
  localStorage.setItem('doxentra_processing_mode', mode);
  // Clear displayed cloud documents and pending source caches at the boundary.
  sessionStorage.removeItem('doxentra_last_docs');
  sessionStorage.removeItem('doxentra_last_graph');
  window.location.reload();
}
