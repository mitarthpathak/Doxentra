import crypto from 'crypto';
import { promisify } from 'util';
import { findUserById } from './db.js';

const scrypt = promisify(crypto.scrypt);
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let warned = false;
function secret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  // Without AUTH_SECRET, derive a stable key from the other server secrets so
  // tokens still survive restarts and work across serverless instances.
  if (!warned) {
    console.warn('[Auth] AUTH_SECRET is not set; deriving one. Set AUTH_SECRET in production.');
    warned = true;
  }
  const base = `${process.env.MONGO_URI || ''}|${process.env.GEMINI_API_KEY || ''}|doxentra`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const sign = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export function createToken(user) {
  const payload = b64url(JSON.stringify({ sub: String(user._id), exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

/** Public shape of a user (never includes the password hash). */
export function publicUser(user) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name || user.email.split('@')[0],
    phone: user.phone || '',
    age: user.age ?? null,
  };
}

/** Attaches req.user when a valid Bearer token is sent; never rejects. */
export async function optionalAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const data = header.startsWith('Bearer ') ? readToken(header.slice(7)) : null;
    if (data) req.user = await findUserById(data.sub);
  } catch (err) {
    console.error('[Auth] token lookup failed:', err.message);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Please sign in to continue.' });
  next();
}
