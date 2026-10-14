import { findLabelled } from '../extract.js';
import { getDocType } from '../schemas.js';
import { normalizedText } from './agreement.js';

const compact = value => normalizedText(value).replace(/\s/g, '');
export const unionBox = boxes => {
  const usable = boxes.filter(b => b?.length === 4);
  return usable.length ? [Math.min(...usable.map(b => b[0])), Math.min(...usable.map(b => b[1])), Math.max(...usable.map(b => b[2])), Math.max(...usable.map(b => b[3]))] : null;
};
const inside = (word, region) => word?.length === 4 && region?.length === 4 &&
  (word[0] + word[2]) / 2 >= region[0] && (word[0] + word[2]) / 2 <= region[2] &&
  (word[1] + word[3]) / 2 >= region[1] && (word[1] + word[3]) / 2 <= region[3];

/** Locate a contiguous value span, preserving weak word/character scores. */
function valueWords(words, value) {
  const target = compact(value);
  for (let start = 0; start < words.length; start++) {
    let joined = '';
    for (let end = start; end < Math.min(start + 80, words.length); end++) {
      joined += compact(words[end].text);
      if (joined === target) return words.slice(start, end + 1);
      if (joined.length > target.length) break;
    }
  }
  return [];
}

export function candidateFor(field, read, { docType, page, cropped = false, region = null, attempt = 0 } = {}) {
  const def = getDocType(docType).fields.find(d => d.key === field.key) || { ...field, aliases: [] };
  const lines = (read.lines?.length ? read.lines : read.text.split('\n').map(text => ({ text, confidence: null, box: null }))).filter(l => l.text.trim());
  let hit = read.status === 'failed' ? null : findLabelled(def, lines.map(l => ({ text: l.text.trim(), page })));
  if (!hit && read.status !== 'failed') {
    // Paddle may omit spaces inside labels ("Invoicenumber:..."). Match the
    // complete label with optional spacing, retaining the engine's raw value.
    const labels = [def.label, def.key.replace(/_/g, ' '), ...(def.aliases || [])].sort((a, b) => b.length - a.length);
    for (const label of labels) {
      const escaped = label.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
      const re = new RegExp(`^${escaped}\\s*[:：–-]\\s*(.+)$`, 'i');
      const line = lines.find(l => re.test(l.text));
      if (line) { hit = { value: line.text.match(re)[1], sourceQuote: line.text }; break; }
    }
  }
  if (!hit && read.status !== 'failed' && ['title', 'title_or_subject', 'certificate_title'].includes(field.key) && lines.length) {
    hit = { value: lines[0].text, sourceQuote: lines[0].text };
  }
  if (!hit && read.status !== 'failed' && field.box?.length === 4 && !cropped) {
    const words = read.words.filter(w => inside(w.box, field.box));
    const observed = words.length ? words.map(w => w.text).join(' ') : lines.filter(l => inside(l.box, field.box)).map(l => l.text).join(' ');
    if (observed.trim()) hit = { value: observed, sourceQuote: observed };
  }
  if (!hit && cropped && read.status !== 'failed' && read.text.trim()) hit = { value: read.text.trim().replace(/\s+/g, ' '), sourceQuote: read.text.trim() };
  // An exact value elsewhere is useful evidence, but only if its location is unique.
  if (!hit && field.value != null && read.status !== 'failed') {
    const matches = lines.filter(l => compact(l.text).includes(compact(field.value)));
    if (matches.length === 1) hit = { value: field.value, sourceQuote: matches[0].text };
  }
  if (!hit) return { engine: read.engine, value: null, confidence: null, page, box: null, attempt, ...(read.error ? { error: read.error } : {}) };
  const sourceLines = lines.filter(l => compact(hit.sourceQuote).includes(compact(l.text)) || compact(l.text).includes(compact(hit.sourceQuote)));
  const bounds = unionBox(sourceLines.map(l => l.box));
  const pool = bounds ? read.words.filter(w => inside(w.box, bounds)) : read.words;
  const words = valueWords(pool, hit.value);
  const measured = words.length ? words.flatMap(w => [w, ...(w.characters || [])]) : sourceLines;
  const scores = measured.map(w => w.confidence);
  // Missing scores are unknown, not zero or fabricated certainty. The minimum
  // prevents a single weak digit from being hidden by an average of strong ones.
  const confidence = scores.length && scores.every(c => c != null) ? Math.min(...scores) : null;
  const candidateBox = cropped ? region : unionBox(words.map(w => w.box)) || bounds || null;
  return { engine: read.engine, value: hit.value.slice(0, 500), sourceQuote: hit.sourceQuote.slice(0, 120), confidence, page, box: candidateBox, attempt,
    confidenceGranularity: words.length ? read.confidenceGranularity : 'line',
    lowConfidenceTokens: measured.filter(w => w.confidence == null || w.confidence < 0.95).slice(0, 40)
      .map(w => ({ text: w.text, confidence: w.confidence, box: cropped ? region : w.box })),
  };
}
