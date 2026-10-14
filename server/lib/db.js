import crypto from 'crypto';
import { isPrivacyMode } from './privacy.js';
import { fallbackLookup } from './dns-fallback.js';
import mongoose from 'mongoose';
import GraphModel from '../models/Graph.js';
import UserModel from '../models/User.js';
import JobModel from '../models/Job.js';
import PacketModel from '../models/Packet.js';
import { translationsOf } from './translit.js';

// Fail fast instead of silently buffering queries for 10s when the
// database is unreachable; callers fall back to the in-memory store.
mongoose.set('bufferCommands', false);

let connectPromise = null;
let lastError = null;
let lastFailAt = 0;
const RETRY_AFTER_MS = 30_000;

/**
 * Connect once and reuse the connection (also across warm serverless
 * invocations). Resolves to true when MongoDB is usable.
 */
export async function connectDB() {
  if (isPrivacyMode()) return false;
  if (!process.env.MONGO_URI) return false;
  if (mongoose.connection.readyState === 1) return true;
  // After a failure, don't make every request wait for another attempt.
  if (!connectPromise && Date.now() - lastFailAt < RETRY_AFTER_MS) return false;
  if (!connectPromise) {
    connectPromise = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, ...(fallbackLookup ? { lookup: fallbackLookup } : {}) })
      .then(() => {
        lastError = null;
        console.log('[DB] MongoDB connected');
        return true;
      })
      .catch(err => {
        lastError = err.message;
        lastFailAt = Date.now();
        console.error('[DB] MongoDB connection failed, using in-memory storage:', err.message);
        connectPromise = null; // allow a retry on a later request
        return false;
      });
  }
  return connectPromise;
}

export function dbStatus() {
  if (isPrivacyMode()) return 'local-only';
  if (!process.env.MONGO_URI) return 'not-configured';
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}
export const dbLastError = () => lastError;

const useMongo = () => !isPrivacyMode() && mongoose.connection.readyState === 1;

// ─── In-memory fallback (data is lost on restart) ───────────────────
const memGraphs = [];
const memPackets = [];
const privateMemPackets = [];
const packetStore = () => isPrivacyMode() ? privateMemPackets : memPackets;
const privatememGraphs = [];
const memGraphsStore = () => isPrivacyMode() ? privatememGraphs : memGraphs;
const memUsers = [];
const privatememUsers = [];
const memUsersStore = () => isPrivacyMode() ? privatememUsers : memUsers;
const newId = () => crypto.randomBytes(12).toString('hex');
const clone = v => JSON.parse(JSON.stringify(v));

// ─── Users ──────────────────────────────────────────────────────────
export async function findUserByEmail(email) {
  if (useMongo()) return UserModel.findOne({ email }).lean();
  return memUsersStore().find(u => u.email === email) || null;
}

export async function findUserById(id) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    return UserModel.findById(id).lean();
  }
  return memUsersStore().find(u => String(u._id) === String(id)) || null;
}

export async function createUser(data) {
  if (useMongo()) return (await UserModel.create(data)).toObject();
  const user = { _id: newId(), createdAt: new Date(), ...data };
  memUsersStore().push(user);
  return user;
}

// ─── Graphs ─────────────────────────────────────────────────────────
export async function findAiGraphByHash(contentHash) {
  if (useMongo()) return GraphModel.findOne({ contentHash, source: 'ai' }).sort({ createdAt: -1 }).lean();
  return [...memGraphsStore()].reverse().find(g => g.contentHash === contentHash && g.source === 'ai') || null;
}

export async function findUserGraphByHash(contentHash, userId) {
  if (useMongo()) return GraphModel.findOne({ contentHash, userId, source: 'ai' }).lean();
  return memGraphsStore().find(g => g.contentHash === contentHash && String(g.userId) === String(userId) && g.source === 'ai') || null;
}

// ─── Document extractions (cached by file hash + extraction version) ─
export async function findExtractionByHash(fileHash, version, ocrConfigHash) {
  const match = g => g.fileHash === fileHash && g.extractionVersion === version && g.source === 'ai' && g.extraction &&
    (ocrConfigHash == null || g.ocrConfigHash === ocrConfigHash);
  if (useMongo()) {
    return GraphModel.findOne({ fileHash, extractionVersion: version, source: 'ai', extraction: { $ne: null }, ...(ocrConfigHash ? { ocrConfigHash } : {}) }).sort({ createdAt: -1 }).lean();
  }
  return [...memGraphsStore()].reverse().find(match) || null;
}

/** The owner's own copy of a cached extraction (owner: a user record or { guestId }). */
export async function findUserExtractionByHash(fileHash, version, owner, ocrConfigHash) {
  if (!owner) return null;
  if (useMongo()) {
    return GraphModel.findOne({ $and: [{ fileHash, extractionVersion: version, source: 'ai', extraction: { $ne: null }, ...(ocrConfigHash ? { ocrConfigHash } : {}) }, ownerFilter(owner)] }).lean();
  }
  return memGraphsStore().find(g => g.fileHash === fileHash && g.extractionVersion === version && g.source === 'ai' &&
    g.extraction && memOwned(g, owner) && (ocrConfigHash == null || g.ocrConfigHash === ocrConfigHash)) || null;
}

export async function saveGraph(doc) {
  if (useMongo()) return (await GraphModel.create(doc)).toObject();
  const saved = { _id: newId(), createdAt: new Date(), ...clone(doc) };
  memGraphsStore().push(saved);
  return saved;
}

/**
 * Records owned by a user (legacy records were keyed by e-mail only) or by a
 * guest workspace ({ guestId }, see owner.js).
 */
function ownerFilter(owner) {
  if (!owner._id && owner.guestId) return { userId: null, guestId: owner.guestId };
  const or = [{ userId: owner._id }];
  if (owner.email) or.push({ userId: null, userEmail: owner.email, guestId: null });
  return { $or: or };
}
function memOwned(g, owner) {
  if (!owner._id && owner.guestId) return !g.userId && g.guestId === owner.guestId;
  return String(g.userId) === String(owner._id) || (!g.userId && !g.guestId && g.userEmail && g.userEmail === owner.email);
}

/** Saved concept maps (extraction-only documents have no graph). */
export async function listGraphs(user, limit = 50) {
  if (useMongo()) {
    return GraphModel.find({ $and: [ownerFilter(user), { graph: { $ne: null } }] }).sort({ createdAt: -1 }).limit(limit).lean();
  }
  return memGraphsStore().filter(g => g.graph && memOwned(g, user)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ─── Documents (records with an extraction) ─────────────────────────
const hasExtraction = { extraction: { $ne: null } };

export async function listDocuments(user, limit = 100) {
  if (useMongo()) {
    return GraphModel.find({ $and: [ownerFilter(user), hasExtraction] })
      .select('-extraction.rawTextByPage')
      .sort({ createdAt: -1 }).limit(limit).lean();
  }
  return memGraphsStore().filter(g => g.extraction && memOwned(g, user)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function getDocument(id, user) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    return GraphModel.findOne({ $and: [{ _id: id }, ownerFilter(user), hasExtraction] }).lean();
  }
  return memGraphsStore().find(g => String(g._id) === String(id) && g.extraction && memOwned(g, user)) || null;
}

/** Add geometry only when the field still has the value used by the locator. */
export async function saveFieldBoxes(id, owner, locations) {
  if (!locations.length) return;
  if (useMongo()) {
    await GraphModel.bulkWrite(locations.map((location, index) => ({ updateOne: {
      filter: { _id: id, ...ownerFilter(owner) },
      update: { $set: { [`extraction.fields.$[field${index}].box`]: location.box } },
      arrayFilters: [{ [`field${index}.key`]: location.key, [`field${index}.value`]: location.value }],
    } })));
    return;
  }
  const doc = memGraphsStore().find(g => String(g._id) === String(id) && memOwned(g, owner));
  if (!doc) return;
  for (const location of locations) {
    const field = doc.extraction?.fields?.find(f => f.key === location.key && f.value === location.value);
    if (field) field.box = [...location.box];
  }
}

/** Set owner-scoped fields; append an audit only if its length is unchanged. */
export async function updateDocument(id, user, patch, { audit, auditLength } = {}) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    const filter = [{ _id: id }, ownerFilter(user)];
    if (audit) filter.push({ $expr: { $eq: [{ $size: { $ifNull: ['$audit', []] } }, auditLength ?? 0] } });
    const update = audit ? { $set: patch, $push: { audit } } : { $set: patch };
    return GraphModel.findOneAndUpdate({ $and: filter }, update, { returnDocument: 'after' }).lean();
  }
  const doc = memGraphsStore().find(g => String(g._id) === String(id) && memOwned(g, user));
  if (!doc) return null;
  if (audit && (doc.audit || []).length !== (auditLength ?? 0)) return null;
  Object.assign(doc, clone(patch));
  if (audit) doc.audit = [...(doc.audit || []), clone(audit)];
  return doc;
}

export async function createPacket(owner, data) {
  const packet = { title: data.title, documentIds: data.documentIds, policyId: data.policyId || null,
    ...(!owner._id ? { userId: null, guestId: owner.guestId } : { userId: owner._id }), updatedAt: new Date() };
  if (useMongo()) return (await PacketModel.create(packet)).toObject();
  const saved = { _id: newId(), createdAt: new Date(), ...clone(packet) };
  packetStore().push(saved);
  return saved;
}

export async function listPackets(owner) {
  if (useMongo()) return PacketModel.find(ownerFilter(owner)).sort({ updatedAt: -1 }).limit(100).lean();
  return packetStore().filter(p => memOwned(p, owner)).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getPacket(id, owner) {
  if (useMongo()) return mongoose.isValidObjectId(id) ? PacketModel.findOne({ $and: [{ _id: id }, ownerFilter(owner)] }).lean() : null;
  return packetStore().find(p => String(p._id) === String(id) && memOwned(p, owner)) || null;
}

export async function updatePacket(id, owner, patch) {
  const fields = { ...patch, updatedAt: new Date() };
  if (useMongo()) return mongoose.isValidObjectId(id) ? PacketModel.findOneAndUpdate({ $and: [{ _id: id }, ownerFilter(owner)] }, { $set: fields }, { returnDocument: 'after' }).lean() : null;
  const packet = await getPacket(id, owner);
  if (!packet) return null;
  Object.assign(packet, clone(fields));
  return packet;
}

/**
 * Candidate documents for a search. With MongoDB the text index narrows
 * them down first; when it finds nothing (prefix or misspelt words) the
 * user's recent documents are ranked in memory instead.
 */
export async function searchCandidates(user, { q, type, from, to } = {}) {
  if (useMongo()) {
    const and = [ownerFilter(user), hasExtraction];
    if (type) and.push({ 'extraction.docType': type });
    if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(from);
      if (to) range.$lte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to);
      and.push({ createdAt: range });
    }
    if (q && q.trim()) {
      // Glossary translations as extra terms (the text index matches any term).
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const search = [...new Set([...words, ...words.flatMap(translationsOf)])].join(' ');
      const hits = await GraphModel.find({ $and: [...and, { $text: { $search: search } }] }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } }).limit(100).lean().catch(err => {
          console.error('[DB] text search failed, ranking in memory:', err.message);
          return [];
        });
      if (hits.length) {
        // A Latin query for Hindi text (and back) is not in the index: rank the latest documents too.
        const recent = await GraphModel.find({ $and: and }).sort({ createdAt: -1 }).limit(100).lean();
        const seen = new Set(hits.map(h => String(h._id)));
        return [...hits, ...recent.filter(d => !seen.has(String(d._id)))];
      }
    }
    return GraphModel.find({ $and: and }).sort({ createdAt: -1 }).limit(300).lean();
  }
  return memGraphsStore().filter(g => g.extraction && memOwned(g, user));
}

/** Move a guest workspace's documents to a signed-in account. Returns how many moved. */
export async function claimGuestDocuments(guestId, user) {
  if (!guestId || !user?._id) return 0;
  if (useMongo()) {
    const res = await GraphModel.updateMany({ guestId, userId: null }, { $set: { userId: user._id }, $unset: { guestId: '' } });
    await JobModel.updateMany({ guestId, userId: null }, { $set: { userId: user._id }, $unset: { guestId: '' } }).catch(() => {});
    await PacketModel.updateMany({ guestId, userId: null }, { $set: { userId: user._id }, $unset: { guestId: '' } }).catch(() => {});
    return res.modifiedCount || 0;
  }
  let n = 0;
  for (const g of memGraphsStore()) {
    if (!g.userId && g.guestId === guestId) {
      g.userId = user._id;
      delete g.guestId;
      n++;
    }
  }
  for (const j of memJobsStore().values()) {
    if (!j.userId && j.guestId === guestId) {
      j.userId = user._id;
      delete j.guestId;
    }
  }
  for (const packet of packetStore()) {
    if (!packet.userId && packet.guestId === guestId) { packet.userId = user._id; delete packet.guestId; }
  }
  return n;
}

/** How many records point at a stored file (so it is only deleted when unused). */
export async function countFileReferences(path) {
  if (useMongo()) return GraphModel.countDocuments({ 'file.path': path });
  return memGraphsStore().filter(g => g.file?.path === path).length;
}

// ─── Jobs (async extraction, see jobs.js) ───────────────────────────
const memJobs = new Map();
const privatememJobs = new Map();
const memJobsStore = () => isPrivacyMode() ? privatememJobs : memJobs;

export async function createJob(job) {
  if (useMongo()) return (await JobModel.create(job)).toObject();
  const saved = { _id: newId(), createdAt: new Date(), updatedAt: new Date(), ...clone(job) };
  memJobsStore().set(String(saved._id), saved);
  // Keep the in-memory store bounded.
  if (memJobsStore().size > 500) memJobsStore().delete(memJobsStore().keys().next().value);
  return clone(saved);
}

export async function getJob(id, owner) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    return JobModel.findOne(owner ? { $and: [{ _id: id }, ownerFilter(owner)] } : { _id: id }).lean();
  }
  const j = memJobsStore().get(String(id));
  return j && (!owner || memOwned(j, owner)) ? clone(j) : null;
}

/**
 * Atomically lease one item of a job for processing: only when it is queued,
 * or running with an expired lease (its worker died). Returns the job or null.
 */
export async function leaseJobItem(jobId, itemId, leaseMs) {
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs);
  if (useMongo()) {
    return JobModel.findOneAndUpdate(
      { _id: jobId, items: { $elemMatch: { id: itemId, $and: [
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { $or: [{ status: 'queued' }, { status: 'running', leaseUntil: { $lt: now } }] },
      ] } } },
      { $set: { 'items.$.status': 'running', 'items.$.leaseUntil': until, 'items.$.startedAt': now, 'items.$.nextAttemptAt': null, updatedAt: now }, $inc: { 'items.$.attempts': 1 } },
      { returnDocument: 'after' },
    ).lean();
  }
  const j = memJobsStore().get(String(jobId));
  const item = j?.items.find(i => i.id === itemId);
  if (!item) return null;
  if (item.nextAttemptAt && new Date(item.nextAttemptAt) > now) return null;
  if (!(item.status === 'queued' || (item.status === 'running' && new Date(item.leaseUntil) < now))) return null;
  Object.assign(item, { status: 'running', leaseUntil: until, startedAt: now, nextAttemptAt: null, attempts: (item.attempts || 0) + 1 });
  j.updatedAt = now;
  return clone(j);
}

/** Set fields of one job item (patch keys are item fields). */
export async function updateJobItem(jobId, itemId, patch, { leaseUntil } = {}) {
  const now = new Date();
  if (useMongo()) {
    const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`items.$.${k}`, v]));
    return JobModel.findOneAndUpdate({ _id: jobId, items: { $elemMatch: { id: itemId, ...(leaseUntil ? { leaseUntil: new Date(leaseUntil), status: 'running' } : {}) } } }, { $set: { ...set, updatedAt: now } }, { returnDocument: 'after' }).lean();
  }
  const j = memJobsStore().get(String(jobId));
  const item = j?.items.find(i => i.id === itemId);
  if (!item) return null;
  if (leaseUntil && (item.status !== 'running' || new Date(item.leaseUntil).getTime() !== new Date(leaseUntil).getTime())) return null;
  Object.assign(item, clone(patch));
  j.updatedAt = now;
  return clone(j);
}

export async function deleteGraph(id, user) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return false;
    const res = await GraphModel.deleteOne({ _id: id, ...ownerFilter(user) });
    return res.deletedCount > 0;
  }
  const idx = memGraphsStore().findIndex(g => String(g._id) === String(id) && memOwned(g, user));
  if (idx === -1) return false;
  memGraphsStore().splice(idx, 1);
  return true;
}
