/**
 * Small fixed-window, per-IP rate limiter (per server instance).
 */
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ success: false, error: message });
    }
    next();
  };
}
