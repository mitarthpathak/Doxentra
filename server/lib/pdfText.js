import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// The library entry (not the package index, which runs a debug self-test).
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// A page with fewer characters than this has no usable text layer.
export const SCANNED_CHARS_PER_PAGE = 40;
// A PDF counts as "mixed" (some pages scanned) when at least this share of its pages has no text layer.
const MIXED_PAGE_SHARE = 0.25;
const MAX_PAGES = 200;
// Text sent to the model; Gemini Flash's context is far larger, this keeps latency and cost down.
export const MAX_PROMPT_TEXT_CHARS = 120_000;
// Mixed PDFs also get the file attached (for OCR of the scanned pages) up to this
// size (larger files go through the Gemini Files API, see ai.js filePart).
const MAX_INLINE_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Whether a page's text layer is garbled: NUL / replacement characters, or
 * Devanagari words that start with a vowel sign (impossible in real text; a
 * common result of Hindi fonts without proper Unicode mapping).
 */
export function isGarbledText(raw) {
  const s = String(raw || '');
  const bad = (s.match(/[\u0000\uFFFD]/g) || []).length;
  const misplacedSigns = (s.match(/(^|[\s/(])[\u093E-\u094C\u0962\u0963]/gm) || []).length;
  return bad >= 2 || misplacedSigns >= 2;
}

const cleanPageText = text =>
  String(text || '')
    .replace(/[\u0000\uFFFD]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * pdf.js page text: a line break where the baseline changes, and a space
 * between items on the same line that are visibly apart (table cells,
 * columns) so values do not run together.
 */
async function renderPage(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  let lastY;
  let lastEnd;
  let text = '';
  for (const item of content.items) {
    const [, , , , x, y] = item.transform;
    if (lastY === undefined) {
      text += item.str;
    } else if (Math.abs(y - lastY) > 1) {
      text += '\n' + item.str;
    } else {
      const gap = x - lastEnd;
      text += (gap > 1.5 && !text.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str;
    }
    lastY = y;
    lastEnd = x + (item.width || 0);
  }
  return text;
}

/**
 * Extract text page by page. Returns
 * { pages: string[], pageCount, avgCharsPerPage, lowTextPages: number[], garbledPages: number[], textLayer }
 * where textLayer is 'digital', 'mixed' or 'scanned'. Never throws: an
 * unreadable PDF is reported as scanned so the OCR path can still try it.
 */
export async function readPdf(buffer) {
  const pages = [];
  const garbled = new Set();
  let pageCount = 0;
  try {
    // Copy: small Buffers are views on Node's shared pool, and pdf.js would
    // read the whole pool instead of just this file.
    const parsed = await pdfParse(new Uint8Array(buffer), {
      max: MAX_PAGES,
      pagerender: async pageData => {
        const raw = await renderPage(pageData);
        const text = cleanPageText(raw);
        // Pages are rendered in order; pageIndex is 0-based when available.
        const index = Number.isInteger(pageData.pageIndex) ? pageData.pageIndex : pages.length;
        pages[index] = text;
        if (isGarbledText(raw)) garbled.add(index + 1);
        return text;
      },
    });
    pageCount = parsed.numpages || pages.length;
  } catch (err) {
    console.error('[PDF] text extraction failed:', err.message);
  }
  for (let i = 0; i < pages.length; i++) pages[i] = pages[i] || '';
  pageCount = Math.max(pageCount, pages.length);
  return { pages, pageCount, garbledPages: [...garbled].sort((a, b) => a - b), ...classifyTextLayer(pages, pageCount) };
}

/** Decide whether a PDF has a usable text layer from its per-page text. */
export function classifyTextLayer(pages, pageCount = pages.length) {
  const counted = Math.max(1, Math.min(pageCount || 0, MAX_PAGES) || pages.length);
  const lengths = Array.from({ length: counted }, (_, i) => (pages[i] || '').replace(/\s/g, '').length);
  const total = lengths.reduce((a, b) => a + b, 0);
  const avgCharsPerPage = Math.round(total / counted);
  const lowTextPages = lengths.map((n, i) => (n < SCANNED_CHARS_PER_PAGE ? i + 1 : 0)).filter(Boolean);
  const textLayer =
    avgCharsPerPage < SCANNED_CHARS_PER_PAGE ? 'scanned'
    : lowTextPages.length / counted >= MIXED_PAGE_SHARE ? 'mixed'
    : 'digital';
  return { avgCharsPerPage, lowTextPages, textLayer };
}

/** Text with explicit page markers so the model can cite page numbers. */
export function pageTaggedText(pages, maxChars = MAX_PROMPT_TEXT_CHARS, unreadablePages = []) {
  let out = '';
  for (let i = 0; i < pages.length; i++) {
    // Garbled text is left out: the model would copy its errors instead of reading the page.
    const body = unreadablePages.includes(i + 1)
      ? '(text layer unreadable: read this page from the attached file)'
      : pages[i] || '(no text layer on this page)';
    const block = `=== PAGE ${i + 1} ===\n${body}\n\n`;
    if (out.length + block.length > maxChars) {
      out += block.slice(0, Math.max(0, maxChars - out.length)) + `\n[... truncated after page ${i + 1} of ${pages.length} ...]`;
      break;
    }
    out += block;
  }
  return out.trim();
}

/**
 * Choose what to send to the model for one validated upload:
 *  - images and scanned PDFs: the file itself (Gemini does OCR + understanding in one call);
 *  - digital PDFs: page-tagged text only (cheapest, and verifiable quotes);
 *  - mixed PDFs (some pages scanned) and PDFs whose text layer is garbled on
 *    some pages: page-tagged text plus the file, so those pages are read visually.
 * Returns { mode: 'text'|'file'|'text+file', ocrUsed, pageCount, pages, textLayer,
 *   unreliablePages (1-based pages whose text layer is missing or garbled), text?, file? }.
 */
export async function prepareDocumentInput({ buffer, kind, mimeType }) {
  if (kind === 'image') {
    return { mode: 'file', ocrUsed: true, pageCount: 1, pages: [], textLayer: 'none', file: { data: buffer, mimeType } };
  }
  const pdf = await readPdf(buffer);
  const unreliablePages = [...new Set([...pdf.lowTextPages, ...pdf.garbledPages])].sort((a, b) => a - b);
  const base = {
    pageCount: pdf.pageCount || 1, pages: pdf.pages, textLayer: pdf.textLayer, avgCharsPerPage: pdf.avgCharsPerPage,
    garbledPages: pdf.garbledPages, unreliablePages,
  };
  const file = { data: buffer, mimeType: 'application/pdf' };
  if (pdf.textLayer === 'scanned') return { ...base, mode: 'file', ocrUsed: true, file, unreliablePages: Array.from({ length: base.pageCount }, (_, i) => i + 1) };
  const text = pageTaggedText(pdf.pages, MAX_PROMPT_TEXT_CHARS, pdf.garbledPages);
  if ((pdf.textLayer === 'mixed' || pdf.garbledPages.length) && buffer.length <= MAX_INLINE_FILE_BYTES) {
    return { ...base, mode: 'text+file', ocrUsed: true, text, file, lowTextPages: unreliablePages };
  }
  return { ...base, mode: 'text', ocrUsed: false, text };
}
