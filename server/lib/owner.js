/**
 * Who owns a request's documents: a signed-in user, or an anonymous guest
 * workspace identified by a random id the browser keeps (header X-Guest-Id).
 * A guest id is a 128-bit+ random secret, so it works like a bearer token for
 * that browser's documents; signing in later moves them to the account.
 */

const GUEST_ID = /^[A-Za-z0-9_-]{20,64}$/;

/** The guest id sent with a request, or null when absent or malformed. */
export function guestIdOf(req) {
  const id = String(req.headers['x-guest-id'] || '').trim();
  return GUEST_ID.test(id) ? id : null;
}

/**
 * req.owner = the signed-in user (a user record, as before) or { guestId }.
 * Runs after optionalAuth; never rejects.
 */
export function attachOwner(req, _res, next) {
  const guestId = guestIdOf(req);
  req.owner = req.user || (guestId ? { guestId } : null);
  next();
}

export function requireOwner(req, res, next) {
  if (!req.owner) return res.status(401).json({ success: false, error: 'Please sign in to continue.' });
  next();
}

export const isGuest = owner => Boolean(owner && !owner._id && owner.guestId);

/** Fields stored on a record to tie it to its owner. */
export function ownerFields(owner) {
  if (!owner) return { userId: null };
  return isGuest(owner) ? { userId: null, guestId: owner.guestId } : { userId: owner._id };
}

/** A storage path prefix that is unique per owner. */
export function ownerKey(owner) {
  if (!owner) return 'anon';
  return isGuest(owner) ? `g_${owner.guestId}` : `u_${owner._id}`;
}

/** Name recorded in audit trails. */
export function ownerLabel(owner) {
  if (!owner) return 'anonymous';
  return isGuest(owner) ? 'guest' : owner.email || String(owner._id);
}
