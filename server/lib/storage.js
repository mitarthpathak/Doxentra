/**
 * Storage of original uploads.
 *
 *  - supabase: Supabase Storage (SUPABASE_URL + SUPABASE_SECRET_KEY). The
 *    browser uploads straight to a signed upload URL, so files skip the API
 *    and Vercel's ~4.5 MB request-body limit (MAX_STORED_UPLOAD_BYTES applies).
 *  - mongo:    a MongoDB collection, when Supabase is not configured.
 *  - memory:   in-process Map (local development and tests; lost on restart).
 *
 * Without Supabase, files reach the API in a normal request, so the 4 MB
 * per-request limit still applies.
 */
import crypto from 'crypto';
import { isPrivacyMode, forbidCloud } from './privacy.js';
import mongoose from 'mongoose';
import StoredFileModel from '../models/StoredFile.js';
import { MAX_UPLOAD_BYTES } from './files.js';
import { supabaseConfig as env, supabaseConfigured, storageRequest as sb } from './supabase.js';

// Per-file limit for direct-to-Supabase uploads (the API never receives the body).
export const MAX_STORED_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNED_READ_TTL_S = 15 * 60;
const MEMORY_BUDGET_BYTES = 300 * 1024 * 1024;

export { supabaseConfigured };
export function storageDriver() {
  if (isPrivacyMode()) return 'memory';
  if (supabaseConfigured()) return 'supabase';
  return mongoose.connection.readyState === 1 ? 'mongo' : 'memory';
}

/** The biggest file the current driver accepts per upload. */
export const maxUploadBytes = () => (supabaseConfigured() ? MAX_STORED_UPLOAD_BYTES : MAX_UPLOAD_BYTES);

/** Local API uploads can relay large files; Vercel's request body cap still applies there. */
export const maxDirectUploadBytes = () => (!process.env.VERCEL && supabaseConfigured() ? MAX_STORED_UPLOAD_BYTES : MAX_UPLOAD_BYTES);

const safeName = name => String(name || 'file').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';

/** A new, unguessable object path under the owner's prefix. */
export function newObjectPath(ownerPrefix, filename) {
  return `uploads/${ownerPrefix}/${Date.now().toString(36)}-${crypto.randomBytes(9).toString('base64url')}-${safeName(filename)}`;
}

// ─── Supabase Storage (REST API) ────────────────────────────────────
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');
let bucketReady = null;
/** Create the private bucket on first use (ignored when it already exists). */
function ensureBucket() {
  if (!bucketReady) {
    const { bucket } = env();
    bucketReady = sb('POST', '/bucket', { body: { id: bucket, name: bucket, public: false, file_size_limit: MAX_STORED_UPLOAD_BYTES } })
      .catch(err => {
        if (!/already exists|409|Duplicate/i.test(`${err.status} ${err.body || err.message}`)) {
          bucketReady = null;
          throw err;
        }
        // An existing bucket must also be private and enforce the upload cap.
        return sb('PUT', `/bucket/${encodeURIComponent(bucket)}`, { body: { public: false, file_size_limit: MAX_STORED_UPLOAD_BYTES } });
      }).catch(err => { bucketReady = null; throw err; });
  }
  return bucketReady;
}

// ─── Fallback drivers ───────────────────────────────────────────────
const memFiles = new Map();
const privateFiles = new Map();
const memoryUsage = { deep: 0, privacy: 0 };
const memoryFiles = () => isPrivacyMode() ? privateFiles : memFiles;
function memPut(path, data, mimeType) {
  const files = memoryFiles();
  const mode = isPrivacyMode() ? 'privacy' : 'deep';
  if (files.has(path)) memoryUsage[mode] -= files.get(path).data.length;
  files.set(path, { data: Buffer.from(data), mimeType });
  memoryUsage[mode] += data.length;
  // Oldest files go first when the budget is exceeded.
  for (const [k, v] of files) {
    if (memoryUsage[mode] <= MEMORY_BUDGET_BYTES) break;
    files.delete(k);
    memoryUsage[mode] -= v.data.length;
  }
}

/**
 * Where the browser should send a file. Supabase: a signed upload URL (PUT
 * the raw bytes). Otherwise { mode: 'direct' }: POST it to /api/uploads.
 */
export async function createUploadTarget({ ownerPrefix, filename, mimeType }) {
  const path = newObjectPath(ownerPrefix, filename);
  // Local browsers can have slow/broken public DNS even when Node's DNS
  // fallback works. Relay locally; deployed uploads still bypass Vercel.
  if (!supabaseConfigured() || !process.env.VERCEL) return { mode: 'direct', maxBytes: maxDirectUploadBytes() };
  await ensureBucket();
  const { url, bucket, anonKey } = env();
  const data = await sb('POST', `/object/upload/sign/${bucket}/${encodePath(path)}`, { body: {} });
  const signed = new URL(`${url}/storage/v1${data.url}`);
  return {
    mode: 'supabase',
    path,
    uploadUrl: signed.toString(),
    method: 'PUT',
    headers: { 'content-type': mimeType || 'application/octet-stream', 'x-upsert': 'false', ...(anonKey ? { apikey: anonKey } : {}) },
    maxBytes: MAX_STORED_UPLOAD_BYTES,
    directMaxBytes: maxDirectUploadBytes(),
  };
}

/** Store bytes at a path with the current driver; returns the file reference. */
export async function putObject(path, data, mimeType) {
  const driver = storageDriver();
  if (driver === 'supabase') {
    await ensureBucket();
    await sb('POST', `/object/${env().bucket}/${encodePath(path)}`, { body: data, headers: { 'content-type': mimeType || 'application/octet-stream', 'x-upsert': 'true' } });
  } else if (driver === 'mongo') {
    await StoredFileModel.updateOne({ _id: path }, { $set: { data, mimeType, size: data.length, createdAt: new Date() } }, { upsert: true });
  } else {
    memPut(path, data, mimeType);
  }
  return { path, driver, mimeType, size: data.length };
}

/** Read a stored file; returns a Buffer or null when it does not exist. */
export async function getObject(ref, { deadline } = {}) {
  const { path, driver = storageDriver() } = typeof ref === 'string' ? { path: ref } : ref || {};
  if (!path) return null;
  if (driver !== 'memory') forbidCloud();
  try {
    if (driver === 'supabase') return await sb('GET', `/object/${env().bucket}/${encodePath(path)}`, { raw: true, deadline });
    if (driver === 'mongo') {
      if (mongoose.connection.readyState !== 1) return null;
      const doc = await StoredFileModel.findById(path).lean();
      return doc ? Buffer.from(doc.data.buffer ?? doc.data) : null;
    }
    return memoryFiles().get(path)?.data || null;
  } catch (err) {
    if (err.status === 400 || err.status === 404) return null;
    throw err;
  }
}

/** A URL the browser can fetch the file from without the API (Supabase only). */
export async function signedReadUrl(ref) {
  if (!process.env.VERCEL) return null;
  if (ref?.driver !== 'supabase' || !supabaseConfigured()) return null;
  const { url, bucket } = env();
  const data = await sb('POST', `/object/sign/${bucket}/${encodePath(ref.path)}`, { body: { expiresIn: SIGNED_READ_TTL_S } });
  return `${url}/storage/v1${data.signedURL || data.signedUrl}`;
}

export async function deleteObject(ref) {
  if (!ref?.path) return;
  if (ref.driver !== 'memory') forbidCloud();
  try {
    if (ref.driver === 'supabase') await sb('DELETE', `/object/${env().bucket}`, { body: { prefixes: [ref.path] } });
    else if (ref.driver === 'mongo') await StoredFileModel.deleteOne({ _id: ref.path });
    else {
      const files = memoryFiles();
      const mode = isPrivacyMode() ? 'privacy' : 'deep';
      if (files.has(ref.path)) memoryUsage[mode] -= files.get(ref.path).data.length;
      files.delete(ref.path);
    }
  } catch (err) {
    console.error('[Storage] delete failed:', err.message);
  }
}

/** Tests only. */
export function resetStorageForTests() {
  bucketReady = null;
  memFiles.clear();
  privateFiles.clear();
  memoryUsage.deep = memoryUsage.privacy = 0;
}
