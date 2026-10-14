import { GeminiKeyPool, getGeminiPool, isGeminiRateLimit } from './geminiPool.js';
import { isTransientError } from './serviceErrors.js';
import { forbidCloud } from './privacy.js';

// Primary model first; later entries are tried when the previous one is
// rate limited, overloaded or times out.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-flash-latest,gemini-flash-lite-latest')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// Pin the fast extraction model: the latest Lite alias can move to a slower
// or overloaded release independently of this app. Keep that alias as backup.
const EXTRACTION_MODELS = process.env.GEMINI_MODEL ? MODELS : ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const modelList = value => value.split(',').map(model => model.trim()).filter(Boolean);
export const visionModelList = (env = process.env) => [...new Set([
  ...modelList(env.GEMINI_VISION_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash-lite'),
  ...modelList(env.GEMINI_VISION_BACKUP_MODEL || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite'),
])];
const VISION_MODELS = visionModelList();
const REASONING_MODELS = modelList(process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite');

// Gemini Flash has a very large context window, so a single call covers
// ~150 pages of text. Anything beyond this is trimmed.
const MAX_TEXT_CHARS = 180_000;

const NODE_TYPES = ['major', 'header', 'sub-topic', 'concept'];

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    metadata: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        complexity: { type: 'integer' },
        category: { type: 'string' },
        roadmap: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              desc: { type: 'string' },
            },
            required: ['title', 'desc'],
          },
        },
        relatedModules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              icon: { type: 'string' },
              title: { type: 'string' },
              desc: { type: 'string' },
            },
            required: ['icon', 'title', 'desc'],
          },
        },
      },
      required: ['title', 'description', 'complexity', 'category', 'roadmap', 'relatedModules'],
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: NODE_TYPES },
          desc: { type: 'string' },
          importance: { type: 'integer' },
          parentId: { type: 'string' },
        },
        required: ['id', 'label', 'type', 'desc', 'importance'],
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['from', 'to', 'label'],
      },
    },
  },
  required: ['metadata', 'nodes', 'links'],
};

const INSTRUCTIONS = `You are an expert teacher turning a study document into a hierarchical knowledge map.

Return JSON matching the schema:
- nodes: a TREE of concepts taken from the document.
  * exactly ONE node of type "major": the core subject of the whole document (no parentId).
  * 3 to 6 nodes of type "header": the main chapters/domains, parentId = the major node id.
  * 2 to 4 nodes of type "sub-topic" under EVERY header (parentId = that header id).
  * 1 to 3 nodes of type "concept" under EVERY sub-topic (parentId = that sub-topic id).
  * ids are short unique strings like "n1", "n2".
  * label: the real technical term used in the document (max 6 words).
  * desc: a clear 1-2 sentence explanation of that term, based on the document.
  * importance: 1-10, how central the idea is.
- links: 0 to 8 extra cross-links between related nodes in DIFFERENT branches
  (not parent/child pairs), with a short verb label such as "uses", "enables", "contrasts with".
- metadata:
  * title: subject title, max 4 words.
  * description: 2 engaging sentences on what the document covers.
  * complexity: integer 1-10.
  * category: broad academic field (e.g. "Computer Science", "Biology").
  * roadmap: 4-5 learning milestones in logical study order, using real topics from the document.
  * relatedModules: 3-5 related topics worth studying next; icon is a Google Material Symbols name (e.g. "science", "functions", "memory").

Be specific and faithful to the document. Never invent content that is not supported by it.`;

let injectedPool = null;
const noThinkingConfig = new Set();
// Files API references belong to the uploading key. Keep legacy calls pinned.
const fileOwners = new WeakMap();
const poolFor = () => injectedPool || getGeminiPool();
function requirePool() {
  const pool = poolFor();
  if (!pool.entries.length) throw Object.assign(new Error('Gemini API keys are not configured on the server'), { code: 'NO_API_KEY' });
  return pool;
}
export function setGeminiClient(fake) {
  injectedPool = fake ? new GeminiKeyPool(['test'], { createClient: () => fake }) : null;
  noThinkingConfig.clear();
}
/** Tests only: inject independent clients to exercise pooling without network. */
export function setGeminiPool(pool) { injectedPool = pool; noThinkingConfig.clear(); }
export function isAiConfigured() { return Boolean(poolFor().entries.length); }

/** Reserve round-robin slots before asynchronous rendering can reorder pages. */
export function reserveGeminiPageSlots(count) {
  if (!count) return [];
  const pool = requirePool();
  const readyModel = VISION_MODELS.find(model => pool.available(model).length);
  if (!readyModel) {
    if (pool.entries.every(e => e.disabled)) throw Object.assign(new Error('Gemini credentials were rejected'), { status: 403 });
    throw Object.assign(new Error('Gemini Vision keys are waiting for quota reset'), {
      status: 429, code: 'AI_QUOTA_EXHAUSTED', retryAt: pool.nextReadyAt(VISION_MODELS),
    });
  }
  return Array.from({ length: count }, () => {
    const entry = pool.take(readyModel);
    return entry ? pool.entries.indexOf(entry) : undefined;
  });
}

// One model attempt never waits longer than this, so a hung call still
// leaves time for the backup model inside Vercel's 60 s limit.
const MAX_ATTEMPT_MS = 40_000;

const isOverloaded = err => {
  const status = err?.status;
  return status === 429 || status === 500 || status === 503 || status === 504 ||
    /overloaded|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(String(err?.message || ''));
};

function isRetryable(err) {
  return err?.status === 404 || isTransientError(err);
}

function thinkingConfigFor(model) {
  if (noThinkingConfig.has(model)) return undefined;
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  // The latest aliases now resolve to Gemini 3. A zero token budget can be
  // rejected; Flash uses low and Flash-Lite supports minimal thinking.
  if (/^gemini-3|^gemini-flash(?:-lite)?-latest$/.test(model)) {
    return { thinkingLevel: /flash-lite/.test(model) ? 'minimal' : 'low' };
  }
  return undefined;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Structured generation with model fallback and immediate 429 key failover. */
export async function generateStructured({ parts, schema, temperature = 0, deadline = Date.now() + 48_000, parse, tag = 'AI', keySlot }) {
  forbidCloud();
  const pool = requirePool();
  const fastExtraction = tag === 'Extract' || tag.startsWith('Gemini.Stage');
  const selectedModels = ['Gemini.Stage1', 'Gemini.Stage3'].includes(tag) ? VISION_MODELS
    : tag === 'Gemini.Stage2' ? REASONING_MODELS : fastExtraction ? EXTRACTION_MODELS : MODELS;
  // Vision tries the primary model on ready keys, then a configured backup if
  // those attempts time out or the provider is overloaded.
  const models = selectedModels;
  const owner = parts.map(part => fileOwners.get(part)).find(Boolean);
  const available = model => pool.available(model).filter(e => !owner || e === owner);
  const order = models.filter(model => available(model).length);
  const quotaError = () => Object.assign(new Error('All ready Gemini keys are waiting for quota reset'), {
    status: 429, code: 'AI_QUOTA_EXHAUSTED', retryAt: pool.nextReadyAt(models, owner) || Date.now() + 60_000,
  });
  if (!order.length) {
    if (pool.entries.every(e => e.disabled)) throw Object.assign(new Error('Gemini credentials were rejected'), { status: 403 });
    throw quotaError();
  }
  let lastErr;
  let badOutputs = 0;
  const briefOverloadRetries = new Map();
  const attempts = fastExtraction ? [...order] : [...order, ...order];
  for (const model of attempts) {
    if (lastErr && isOverloaded(lastErr) && deadline - Date.now() >= 4500) await sleep(500);
    const tried = new Set();
    while (available(model).some(e => !tried.has(e.id))) {
      const remaining = deadline - Date.now();
      if (remaining < 4000) break;
      const preferredId = Number.isInteger(keySlot) ? pool.entries[((keySlot % pool.entries.length) + pool.entries.length) % pool.entries.length]?.id : undefined;
      const entry = owner || pool.take(model, tried, preferredId);
      if (!entry || tried.has(entry.id)) break;
      tried.add(entry.id);
      const controller = new AbortController();
      const backupPending = available(model).some(e => !tried.has(e.id)) || order.some(m => m !== model && available(m).length);
      // Once we reach the second key, give it a usable window on the fast model
      // rather than reserving most of its budget for moving model aliases.
      const reserve = remaining >= 9000 && backupPending && !(tag.startsWith('Gemini.Stage') && tried.size > 1)
        ? Math.min(fastExtraction ? 8000 : 20_000, Math.floor(remaining * 0.45)) : 0;
      // Bound the first OCR model so a timeout on one key plus an overload on
      // another still leaves a useful window for the backup vision model.
      const primaryVisionWithBackup = tag === 'Gemini.Stage1' && order.length > 1 && model === order[0];
      const attemptCap = primaryVisionWithBackup ? 12_000 : fastExtraction ? 15_000 : MAX_ATTEMPT_MS;
      const timer = setTimeout(() => controller.abort(), Math.min(remaining - reserve, attemptCap));
      const config = { responseMimeType: 'application/json', responseJsonSchema: schema, temperature, abortSignal: controller.signal };
      const thinkingConfig = thinkingConfigFor(model);
      if (thinkingConfig) config.thinkingConfig = thinkingConfig;
      try {
        const started = Date.now();
        const res = await entry.client.models.generateContent({ model, contents: [{ role: 'user', parts }], config });
        const parsed = parse(res.text);
        console.log(`[${tag}] ${entry.id} ${res.modelVersion || model} answered in ${Date.now() - started}ms`);
        return { ...parsed, model: res.modelVersion || model };
      } catch (caught) {
        const err = controller.signal.aborted && (caught?.name === 'AbortError' || caught?.code === 20)
          ? Object.assign(new Error('Gemini request timed out'), { code: 'AI_TIMEOUT', cause: caught }) : caught;
        lastErr = err;
        // Provider errors can contain request data; never log keys or document text.
        console.error(`[${tag}] ${entry.id} ${model} failed: ${err?.status || err?.code || err?.name || 'error'}`);
        if (err?.status === 400 && config.thinkingConfig && /thinking|budget|level/i.test(String(err.message))) {
          noThinkingConfig.add(model); tried.delete(entry.id); continue;
        }
        if (err instanceof SyntaxError || ['EMPTY_GRAPH', 'BAD_AI_OUTPUT'].includes(err?.code)) {
          if (++badOutputs > 1) throw Object.assign(new Error('The AI returned an unreadable answer twice.'), { code: 'BAD_AI_OUTPUT', cause: err });
          attempts.push(model);
          continue;
        }
        if (isGeminiRateLimit(err)) {
          pool.cool(entry, model, err);
          // No sleep: try the next ready key immediately, before changing models.
          continue;
        }
        if ([401, 403].includes(Number(err?.status)) || (Number(err?.status) === 400 && /API_KEY_INVALID|API key not valid|invalid.*key/i.test(String(err?.message || '')))) {
          entry.disabled = true;
          if (available(model).some(e => !tried.has(e.id))) continue;
          // A valid key may still be cooling; let the job wait instead of failing.
          if (pool.entries.some(e => !e.disabled) && models.every(m => !available(m).length)) throw quotaError();
          throw err;
        }
        if (isTransientError(err) && available(model).some(e => !tried.has(e.id))) continue;
        if (tag.startsWith('Gemini.Stage') && err?.status === 503 && deadline - Date.now() >= 8000) {
          const key = `${entry.id}:${model}`;
          if (!briefOverloadRetries.has(key)) {
            briefOverloadRetries.set(key, true);
            tried.delete(entry.id);
            await sleep(250);
            continue;
          }
        }
        if (!isRetryable(err)) throw err;
        break; // transient outage: next model, bounded by the same deadline
      } finally { clearTimeout(timer); }
    }
    if (deadline - Date.now() < 4000) break;
  }
  if (models.every(model => !available(model).length) && pool.entries.some(e => !e.disabled)) throw quotaError();
  throw lastErr || Object.assign(new Error('AI analysis ran out of time'), { code: 'AI_TIMEOUT' });
}

// Gemini accepts at most ~20 MB per request; bigger files go through the Files API.
export const MAX_INLINE_FILE_BYTES = 14 * 1024 * 1024;

/**
 * The request part for a file: inline base64 for normal files, or an upload
 * to the Gemini Files API (then a file reference) for large ones, e.g. long
 * scanned PDFs uploaded straight to Supabase Storage.
 */
export async function filePart({ data, mimeType }, { deadline } = {}) {
  forbidCloud();
  if (data.length <= MAX_INLINE_FILE_BYTES) return { inlineData: { mimeType, data: data.toString('base64') } };
  const entry = requirePool().take('__files__');
  const ai = entry.client;
  if (!ai.files?.upload) throw Object.assign(new Error('File is too large for the AI service.'), { code: 'FILE_TOO_LARGE' });
  const started = Date.now();
  let file = await ai.files.upload({ file: new Blob([data], { type: mimeType }), config: { mimeType } });
  // PDFs are processed asynchronously by the Files API before they can be used.
  while (file.state === 'PROCESSING' && (!deadline || Date.now() < deadline - 8000)) {
    await sleep(1000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state === 'FAILED') throw Object.assign(new Error('The AI service could not read this file.'), { code: 'FILE_FAILED' });
  console.log(`[AI] uploaded ${Math.round(data.length / 1024)} KB to the Files API in ${Date.now() - started}ms`);
  const part = { fileData: { fileUri: file.uri, mimeType: file.mimeType || mimeType } };
  fileOwners.set(part, entry);
  return part;
}

/**
 * Ask Gemini for the knowledge map.
 * `input` is either { text } (extracted PDF text) or { file: { data, mimeType } }
 * (raw PDF/image bytes, used for scanned documents and photos that have no
 * text layer; { pdf } is accepted as a shorthand for a PDF buffer).
 * `deadline` is an absolute timestamp (ms) the whole call must finish by.
 */
export async function analyzeDocument(input, { deadline }) {
  const parts = [{ text: INSTRUCTIONS }];
  const file = input.file || (input.pdf && { data: input.pdf, mimeType: 'application/pdf' });
  if (file) {
    parts.push(await filePart(file, { deadline }));
  } else {
    parts.push({ text: `DOCUMENT:\n${input.text.slice(0, MAX_TEXT_CHARS)}` });
  }
  return generateStructured({
    parts,
    schema: RESPONSE_SCHEMA,
    temperature: 0.3,
    deadline,
    parse: text => normalizeResult(parseJson(text)),
  });
}

/** Close an answer cut off mid-way (open strings, arrays, objects). */
function closeTruncatedJson(raw) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = raw + (inString ? '"' : '');
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  return out + stack.reverse().join('');
}

/**
 * Parse a JSON answer, repairing the usual problems: code fences, text
 * around the object, trailing commas and a truncated end.
 * Throws SyntaxError when it cannot be repaired.
 */
export function parseJson(text) {
  const raw = String(text || '').replace(/```(?:json)?/g, '').trim();
  const candidates = [raw];
  const start = raw.indexOf('{');
  if (start > 0) candidates.push(raw.slice(start));
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const c of [...candidates]) candidates.push(c.replace(/,\s*([}\]])/g, '$1'));
  if (start >= 0) candidates.push(closeTruncatedJson(raw.slice(start)).replace(/,\s*([}\]])/g, '$1'));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try the next repair */
    }
  }
  throw new SyntaxError('AI returned invalid JSON');
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Turn whatever the model returned into a clean, connected tree:
 * unique ids, exactly one root, every other node attached to a parent,
 * and edges in { source, target } form for the frontend.
 */
export function normalizeResult(parsed) {
  const rawNodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  const nodes = [];
  const byId = new Map();

  for (const n of rawNodes) {
    const label = str(n?.label, 80);
    if (!label) continue;
    let id = str(String(n?.id ?? ''), 40) || `n${nodes.length + 1}`;
    while (byId.has(id)) id = `${id}_`;
    const node = {
      id,
      label,
      type: NODE_TYPES.includes(n?.type) ? n.type : 'concept',
      desc: str(n?.desc, 600),
      importance: clampInt(n?.importance, 1, 10, 5),
      parentId: str(String(n?.parentId ?? ''), 40) || null,
    };
    nodes.push(node);
    byId.set(id, node);
  }

  if (nodes.length === 0) {
    const err = new Error('AI returned an empty graph');
    err.code = 'EMPTY_GRAPH';
    throw err;
  }

  // Exactly one root.
  let root = nodes.find(n => n.type === 'major' && !byId.has(n.parentId)) || nodes.find(n => n.type === 'major') || nodes[0];
  root.type = 'major';
  root.parentId = null;
  for (const n of nodes) {
    if (n !== root && n.type === 'major') n.type = 'header';
  }

  // Attach orphans (missing/unknown/self parent) to the root, and break cycles.
  for (const n of nodes) {
    if (n === root) continue;
    if (!n.parentId || !byId.has(n.parentId) || n.parentId === n.id) n.parentId = root.id;
  }
  for (const n of nodes) {
    const seen = new Set([n.id]);
    let cur = byId.get(n.parentId);
    while (cur && cur.parentId) {
      if (seen.has(cur.id)) { n.parentId = root.id; break; }
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
  }

  // Node type follows depth so the graph layout is always consistent.
  const depthTypes = ['major', 'header', 'sub-topic', 'concept'];
  const depthOf = n => {
    let d = 0;
    let cur = n;
    while (cur.parentId && d < 10) { cur = byId.get(cur.parentId); d++; }
    return d;
  };
  for (const n of nodes) n.type = depthTypes[Math.min(depthOf(n), 3)];

  const edges = [];
  const seenPairs = new Set();
  const addEdge = (a, b, label, importance) => {
    if (!byId.has(a) || !byId.has(b) || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    edges.push({ source: a, target: b, label, importance });
  };
  for (const n of nodes) {
    if (n.parentId) addEdge(n.parentId, n.id, 'contains', n.type === 'header' ? 8 : n.type === 'sub-topic' ? 6 : 4);
  }
  for (const l of Array.isArray(parsed?.links) ? parsed.links : []) {
    addEdge(str(l?.from, 40), str(l?.to, 40), str(l?.label, 40) || 'related', 3);
  }

  const m = parsed?.metadata || {};
  const roadmapItems = (Array.isArray(m.roadmap) ? m.roadmap : []).filter(r => str(r?.title)).slice(0, 6);
  const metadata = {
    title: str(m.title, 60) || root.label,
    description: str(m.description, 500),
    complexity: clampInt(m.complexity, 1, 10, 5),
    category: str(m.category, 60) || 'General Study',
    roadmap: roadmapItems.map((r, i) => ({
      number: String(i + 1).padStart(2, '0'),
      title: str(r.title, 80),
      status: i === 0 ? 'completed' : i === 1 ? 'in-progress' : 'locked',
      desc: str(r.desc, 300),
    })),
    relatedModules: (Array.isArray(m.relatedModules) ? m.relatedModules : [])
      .filter(r => str(r?.title))
      .slice(0, 6)
      .map(r => ({
        icon: /^[a-z0-9_]{2,40}$/.test(str(r.icon)) ? str(r.icon) : 'auto_stories',
        title: str(r.title, 80),
        desc: str(r.desc, 200),
      })),
  };

  return { graph: { nodes, edges }, metadata };
}

/**
 * Offline fallback when the AI is unavailable: a frequency-based tree built
 * from the document's most common terms.
 */
const STOPWORDS = new Set((
  'about above after again against because before being below between could doing during ' +
  'further having other their there these those through under until where which while would should itself ' +
  'yourself themselves within without also however therefore thus since using used based among each every ' +
  'shall might first second third another figure table chapter section page pages example'
).split(' '));

export function buildFallbackGraph(text) {
  const freq = new Map();
  for (const w of text.toLowerCase().match(/\b[a-z][a-z-]{4,}\b/g) || []) {
    if (STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1);

  const nodes = [];
  if (top.length === 0) top.push('document');
  const root = { id: 'f0', label: cap(top[0]), type: 'major', importance: 10, parentId: null,
    desc: `Most frequent key term in the document ("${top[0]}").` };
  nodes.push(root);
  const headers = top.slice(1, 5);
  const rest = top.slice(5);
  headers.forEach((w, i) => {
    nodes.push({ id: `f${nodes.length}`, label: cap(w), type: 'header', importance: 8, parentId: root.id,
      desc: `Recurring term "${w}" found through frequency analysis.` });
  });
  const headerNodes = nodes.slice(1);
  rest.forEach((w, i) => {
    const parent = headerNodes.length ? headerNodes[i % headerNodes.length] : root;
    nodes.push({ id: `f${nodes.length}`, label: cap(w), type: parent === root ? 'header' : 'sub-topic',
      importance: 5, parentId: parent.id, desc: `Related term "${w}" found through frequency analysis.` });
  });
  const edges = nodes.filter(n => n.parentId).map(n => ({ source: n.parentId, target: n.id, label: 'related', importance: 5 }));

  return {
    graph: { nodes, edges },
    metadata: {
      title: cap(top[0]),
      description: 'AI analysis was unavailable, so this map was built from the most frequent terms in the document. Try uploading again later for a full AI analysis.',
      complexity: 5,
      category: 'General Study',
      roadmap: [
        { number: '01', title: 'Preliminary Scan', status: 'completed', desc: 'Identify the recurring terminology.' },
        { number: '02', title: 'Structural Mapping', status: 'in-progress', desc: 'Group related terms together.' },
        { number: '03', title: 'Deep Analysis', status: 'locked', desc: 'Re-run with AI for full explanations.' },
      ],
      relatedModules: [],
    },
  };
}
