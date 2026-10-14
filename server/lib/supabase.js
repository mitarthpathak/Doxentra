/** Server-only Supabase Storage service client. Never return its credentials. */
import { isTransientError } from './serviceErrors.js';
import { isPrivacyMode, forbidCloud } from './privacy.js';

export const supabaseConfig = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  anonKey: process.env.SUPABASE_ANON_KEY || '',
  bucket: process.env.SUPABASE_BUCKET || 'documents',
});

export const supabaseConfigured = () => !isPrivacyMode() && Boolean(supabaseConfig().url && supabaseConfig().key);

export async function storageRequest(method, path, { body, headers = {}, raw = false, deadline } = {}) {
  forbidCloud();
  const { url, key } = supabaseConfig();
  if (!url || !key) throw new Error('Supabase Storage is not configured');
  const json = body && !Buffer.isBuffer(body) && !(body instanceof Uint8Array);
  // Only replay reads. Signed uploads and other writes may have succeeded
  // even when their response was lost. Bound retries by one total deadline.
  const read = method === 'GET';
  const transfer = raw || Buffer.isBuffer(body) || body instanceof Uint8Array;
  const requestTimeout = read ? (raw ? 15_000 : 10_000) : (transfer ? 30_000 : 10_000);
  const until = Math.min(deadline ?? Infinity, Date.now() + (read ? 20_000 : requestTimeout));
  let lastError;
  for (let attempt = 0; attempt < (read ? 3 : 1); attempt++) {
    const remaining = until - Date.now();
    if (remaining <= 0) break;
    try {
      const res = await fetch(`${url}/storage/v1${path}`, {
        method,
        signal: AbortSignal.timeout(Math.min(remaining, requestTimeout)),
        headers: {
          apikey: key,
          // New secret keys are not JWTs. Legacy service-role JWTs need Bearer auth.
          ...(!key.startsWith('sb_secret_') ? { Authorization: `Bearer ${key}` } : {}),
          ...(json ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: json ? JSON.stringify(body) : body,
      });
      if (!res.ok) {
        const responseBody = await res.text().catch(() => '');
        throw Object.assign(new Error(`Supabase Storage request failed (${res.status})`), { status: res.status, body: responseBody });
      }
      // Keep body consumption inside the retry: downloads can time out after
      // the response headers have arrived, before all file bytes are read.
      if (raw) return Buffer.from(await res.arrayBuffer());
      return await ((res.headers.get('content-type') || '').includes('json') ? res.json() : res.text());
    } catch (err) {
      lastError = err;
      if (!read || !isTransientError(err) || attempt === 2) throw err;
      const delay = 250 * (attempt + 1);
      if (Date.now() + delay >= until) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || Object.assign(new Error('Supabase Storage download timed out'), { code: 'STORAGE_TIMEOUT' });
}
