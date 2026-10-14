import type { DocumentResult, GraphData, GraphEdge, GraphNode, NodeType, SavedGraph, User } from '../types';
import { getProcessingMode } from './processingMode';

const TOKEN_KEY = 'doxentra_token';
const GUEST_KEY = 'doxentra_guest';
let memoryGuestId: string | null = null;

/**
 * Anonymous workspace id of this browser: documents uploaded without signing
 * in belong to it (sent as X-Guest-Id) and move to the account on sign-in.
 */
export function getGuestId(): string {
  try {
    const saved = localStorage.getItem(GUEST_KEY);
    if (saved) return saved;
  } catch {
    /* storage unavailable: keep the id for this page load */
  }
  if (!memoryGuestId) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    memoryGuestId = 'g' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    localStorage.setItem(GUEST_KEY, memoryGuestId);
  } catch {
    /* ignore */
  }
  return memoryGuestId;
}

/** Headers that identify the caller: the account token and the guest workspace. */
export function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set('X-Processing-Mode', getProcessingMode());
  const token = getToken();
  if (token && getProcessingMode() !== 'privacy') headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-Guest-Id', getGuestId());
  return headers;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — session lasts until reload */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch() wrapper: adds the auth token and always resolves to parsed JSON,
 * turning HTML error pages / timeouts into readable messages.
 */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError('Could not reach the server. Check your internet connection and try again.', 0);
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }

  if (!res.ok || !data || data.success === false) {
    const fallback =
      res.status === 413 ? 'File is too large. Maximum size is 4 MB.' :
      res.status === 504 ? 'The server took too long to respond. Please try again.' :
      res.status === 429 ? 'Too many requests. Please wait a moment and try again.' :
      `Request failed (${res.status}). Please try again.`;
    throw new ApiError(data?.error || fallback, res.status);
  }
  return data as T;
}

// ─── Auth ───────────────────────────────────────────────────────────
/** Documents uploaded before signing in move to the account. */
const claimGuestDocuments = () => apiFetch('/guest/claim', { method: 'POST' }).catch(() => null);

export async function signup(input: { email: string; password: string; phone: string; age: number }) {
  const data = await apiFetch<{ token: string; user: User }>('/auth/signup', { method: 'POST', body: JSON.stringify(input) });
  setToken(data.token);
  await claimGuestDocuments();
  return data.user;
}

export async function login(email: string, password: string) {
  const data = await apiFetch<{ token: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  setToken(data.token);
  await claimGuestDocuments();
  return data.user;
}

export async function fetchCurrentUser(): Promise<User | null> {
  if (!getToken()) return null;
  try {
    return (await apiFetch<{ user: User }>('/auth/me')).user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) setToken(null);
    return null;
  }
}

// ─── Graph data ─────────────────────────────────────────────────────
const NODE_TYPES: NodeType[] = ['major', 'header', 'sub-topic', 'concept'];

/** Maps any saved/legacy graph shape onto the one the screens expect. */
export function toGraphData(item: SavedGraph): GraphData {
  const rawNodes: any[] = item.graph?.nodes || (item as any).nodes || [];
  const rawEdges: any[] = item.graph?.edges || (item as any).edges || [];

  const legacyType: Record<string, NodeType> = { core: 'major', minor: 'concept' };
  const nodes: GraphNode[] = rawNodes
    .filter(n => n && n.id != null && n.label)
    .map(n => ({
      id: String(n.id),
      label: String(n.label),
      type: NODE_TYPES.includes(n.type) ? n.type : legacyType[n.type] || 'concept',
      desc: n.desc || '',
      importance: Number(n.importance) || 5,
      parentId: n.parentId ?? null,
    }));

  // Old records may have several "core" nodes; keep a single root.
  const roots = nodes.filter(n => n.type === 'major');
  roots.slice(1).forEach(n => (n.type = 'header'));
  if (roots.length === 0 && nodes.length > 0) nodes[0].type = 'major';

  const ids = new Set(nodes.map(n => n.id));
  const edges: GraphEdge[] = rawEdges
    .map(e => ({
      source: String(e.source?.id ?? e.source ?? e.from),
      target: String(e.target?.id ?? e.target ?? e.to),
      label: e.label,
      importance: Number(e.importance) || 5,
    }))
    .filter(e => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);

  return {
    id: item.id || item._id,
    nodes,
    edges,
    metadata: item.metadata || {},
    filename: item.filename || 'document.pdf',
    fallbackUsed: item.fallbackUsed,
  };
}

// ─── Document intelligence ──────────────────────────────────────────
export const DOC_TYPE_OPTIONS = [
  { id: 'invoice', label: 'Invoice' },
  { id: 'certificate', label: 'Certificate' },
  { id: 'marksheet', label: 'Marksheet / report card' },
  { id: 'application_form', label: 'Application / form' },
  { id: 'report', label: 'Report' },
  { id: 'identity_document', label: 'Identity document' },
  { id: 'institutional_record', label: 'Letter / notice / record' },
  { id: 'other', label: 'Other document' },
];

export function confidenceBand(c: number | null | undefined): 'high' | 'medium' | 'low' {
  const v = c ?? 0;
  return v >= 0.8 ? 'high' : v >= 0.5 ? 'medium' : 'low';
}

export const percent = (c: number | null | undefined) => `${Math.round((c ?? 0) * 100)}%`;

/** Saves a downloaded file in the browser. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export a document as JSON or CSV. Saved documents (account or guest
 * workspace) are exported by id; otherwise the result on screen is sent for
 * formatting.
 */
/** Download a document as JSON or CSV; redact: personal data masked (pass the masked document for its file name). */
export async function exportDocument(doc: DocumentResult, format: 'json' | 'csv', saved: boolean, redact = false) {
  const headers = authHeaders();
  const query = `format=${format}${redact ? '&redact=1' : ''}`;
  let res: Response;
  try {
    if (saved) {
      res = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/export?${query}`, { headers });
    } else {
      headers.set('Content-Type', 'application/json');
      res = await fetch(`/api/documents/export?${query}`, { method: 'POST', headers, body: JSON.stringify(doc) });
    }
  } catch {
    throw new ApiError('Could not reach the server. Check your internet connection and try again.', 0);
  }
  if (!res.ok) {
    let message = `Export failed (${res.status}).`;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status);
  }
  const base = doc.filename.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'document';
  saveBlob(await res.blob(), `${base}-${redact ? 'redacted' : 'extraction'}.${format}`);
}
