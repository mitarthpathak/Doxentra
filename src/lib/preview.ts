/**
 * Page previews for source highlighting.
 *
 * The original file is loaded once per document (Supabase signed URL or the
 * API). PDF pages are rendered with pdf.js, loaded only when a preview is
 * first opened. Where a value is on the page:
 *  - digital PDFs: the value (inside its quote) is looked up in pdf.js's
 *    positioned text items, so the box is exact;
 *  - scans and photos: the bounding box the AI reported for the field
 *    ([ymin, xmin, ymax, xmax] on a 0-1000 scale), marked approximate.
 * Boxes are returned as percentages of the page so they scale with it.
 */
import { ApiError, apiFetch, authHeaders } from './api';

export interface Rect { left: number; top: number; width: number; height: number } // % of the page

export interface LoadedSource {
  kind: 'pdf' | 'image';
  url: string; // object URL
  data: ArrayBuffer;
}

const sources = new Map<string, Promise<LoadedSource>>();
const pdfs = new Map<string, Promise<any>>();
interface FieldLocation { key: string; value: string; box: number[] | null }
const locations = new Map<string, FieldLocation[]>();
const locating = new Map<string, Promise<FieldLocation[]>>();

/** Resolve missing scan coordinates once per page; only successful boxes are cached. */
export async function locateFieldBox(docId: string, page: number, fieldKey: string, value: string | null): Promise<number[] | null> {
  const id = `${docId}:${page}`;
  const matches = (f: FieldLocation) => f.key === fieldKey && f.value === value;
  const cached = locations.get(id)?.find(matches);
  if (cached?.box) return cached.box;
  if (!locating.has(id)) {
    const work = apiFetch<{ locations: FieldLocation[] }>(`/documents/${encodeURIComponent(docId)}/field-locations`, {
      method: 'POST', body: JSON.stringify({ page }),
    }).then(result => {
      locations.set(id, result.locations.filter(f => f.box?.length === 4));
      return result.locations;
    });
    locating.set(id, work);
    work.finally(() => locating.delete(id)).catch(() => {});
  }
  return (await locating.get(id)!).find(matches)?.box || null;
}

async function fetchSource(url: string, external: boolean): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, external ? {} : { headers: authHeaders() });
    if (!res.ok) throw new ApiError('The original file is not available.', res.status);
    return await res.blob();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('Could not load the original file.', 0);
  }
}

/** The original file of a document (cached for the page's lifetime). */
export function loadSource(docId: string): Promise<LoadedSource> {
  if (!sources.has(docId)) {
    const p = (async () => {
      const info = await apiFetch<{ url: string; external: boolean; mimeType?: string }>(`/documents/${encodeURIComponent(docId)}/file-url`);
      let blob: Blob;
      try {
        blob = await fetchSource(info.url, info.external);
      } catch (err) {
        if (!info.external) throw err;
        // Match the upload relay: a browser that cannot reach Storage can
        // still view the original through the owner's authenticated API.
        blob = await fetchSource(`/api/documents/${encodeURIComponent(docId)}/file`, false);
      }
      const type = info.mimeType || blob.type;
      return { kind: /pdf/i.test(type) ? 'pdf' : 'image', url: URL.createObjectURL(blob), data: await blob.arrayBuffer() } as LoadedSource;
    })();
    p.catch(() => sources.delete(docId)); // allow a retry
    sources.set(docId, p);
  }
  return sources.get(docId)!;
}

let pdfjsPromise: Promise<any> | null = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function loadPdf(docId: string) {
  if (!pdfs.has(docId)) {
    const p = (async () => {
      const [lib, src] = await Promise.all([pdfjs(), loadSource(docId)]);
      // pdf.js takes ownership of the buffer it is given, so pass a copy.
      return lib.getDocument({ data: src.data.slice(0) }).promise;
    })();
    p.catch(() => pdfs.delete(docId));
    pdfs.set(docId, p);
  }
  return pdfs.get(docId)!;
}

/** Render one page into a canvas at the given CSS width; returns the page and viewport. */
export async function renderPdfPage(docId: string, pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) {
  const pdf = await loadPdf(docId);
  const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
  return { page, viewport, numPages: pdf.numPages as number };
}

// ─── Locating text on a PDF page ────────────────────────────────────
const DEVANAGARI_DIGITS = /[०-९]/g;
/** Comparison form: NFKC, lower case, ASCII digits, no whitespace. */
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(DEVANAGARI_DIGITS, d => String(d.charCodeAt(0) - 0x0966)).replace(/\s+/g, '');

interface Item { str: string; transform: number[]; width: number; height: number }

/**
 * Boxes (as % of the page) of `value` on a PDF page, preferably inside
 * `quote`; falls back to the quote itself. Empty when neither is found.
 */
export async function findTextRects(page: any, viewport: any, quote: string | null, value: string | null): Promise<Rect[]> {
  const lib = await pdfjs();
  const content = await page.getTextContent();
  const items: Item[] = content.items.filter((it: any) => typeof it.str === 'string' && it.str.length);
  let text = '';
  const map: { item: number; char: number }[] = [];
  items.forEach((it, i) => {
    const s = it.str.normalize('NFKC');
    for (let c = 0; c < s.length; c++) {
      const ch = norm(s[c]);
      if (!ch) continue;
      for (const x of ch) {
        text += x;
        map.push({ item: i, char: c });
      }
    }
  });
  if (!text) return [];

  const q = quote ? norm(quote.replace(/…$/, '')) : '';
  const v = value ? norm(value) : '';
  let range: [number, number] | null = null;
  const qAt = q.length >= 3 ? text.indexOf(q) : -1;
  if (qAt >= 0) {
    const vIn = v ? text.slice(qAt, qAt + q.length).indexOf(v) : -1;
    range = vIn >= 0 ? [qAt + vIn, qAt + vIn + v.length] : [qAt, qAt + q.length];
  } else if (v.length >= 3 && text.includes(v)) {
    const at = text.indexOf(v);
    range = [at, at + v.length];
  } else if (q.length >= 12) {
    // The quote may have been shortened or paraphrased at the end: try its start.
    const head = q.slice(0, Math.min(30, q.length));
    const at = text.indexOf(head);
    if (at >= 0) range = [at, at + head.length];
  }
  if (!range) return [];

  // Characters per item within the range.
  const spans = new Map<number, [number, number]>();
  for (let k = range[0]; k < range[1]; k++) {
    const { item, char } = map[k];
    const cur = spans.get(item);
    spans.set(item, cur ? [Math.min(cur[0], char), Math.max(cur[1], char)] : [char, char]);
  }
  const rects: Rect[] = [];
  for (const [i, [c0, c1]] of spans) {
    const it = items[i];
    const tx = lib.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || it.height * viewport.scale;
    const width = it.width * viewport.scale;
    const len = it.str.normalize('NFKC').length || 1;
    const left = tx[4] + (width * c0) / len;
    const right = tx[4] + (width * (c1 + 1)) / len;
    rects.push({
      left: (left / viewport.width) * 100,
      top: ((tx[5] - fontHeight * 0.95) / viewport.height) * 100,
      width: (Math.max(right - left, 2) / viewport.width) * 100,
      height: ((fontHeight * 1.25) / viewport.height) * 100,
    });
  }
  return mergeLines(rects);
}

/** Merge boxes on the same line into one, so a value split over items is one highlight. */
function mergeLines(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.top - r.top) < r.height * 0.5 && r.left - (last.left + last.width) < 3) {
      const right = Math.max(last.left + last.width, r.left + r.width);
      last.left = Math.min(last.left, r.left);
      last.width = right - last.left;
      last.height = Math.max(last.height, r.height);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** An AI bounding box [ymin, xmin, ymax, xmax] (0-1000) as a page rectangle. */
export function boxToRect(box: number[]): Rect {
  const [y0, x0, y1, x1] = box;
  return { left: x0 / 10, top: y0 / 10, width: (x1 - x0) / 10, height: (y1 - y0) / 10 };
}
